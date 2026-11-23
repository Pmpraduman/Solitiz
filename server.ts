import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import net from 'net';
import multer from 'multer';
import { fileURLToPath, pathToFileURL } from 'url';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FirebaseConfigFile {
  projectId: string;
}

interface ParsedChunk {
  chunkIndex: number;
  pageNumber: number;
  sectionTitle: string;
  text: string;
  charCount: number;
}

interface AuthorizedChunkInput {
  docId: string;
  documentTitle: string;
  pageNumber: number;
  sectionTitle?: string;
  text: string;
  redactPiiOnTransmit?: boolean;
}

interface AskCitation {
  docId: string;
  documentTitle: string;
  pageNumber: number;
  exactQuote: string;
}

interface AskStructuredSection {
  heading: string;
  points: string[];
}

interface AskModelPayload {
  answeredFromDocuments: boolean;
  summary: string;
  sections: AskStructuredSection[];
  answer: string;
  abstentionReason: string;
  citations: AskCitation[];
}

interface EvaluationCasePayload {
  id: string;
  question: string;
  expectedBehavior: 'must_answer' | 'must_abstain';
  expectedKeywords?: string[];
}

interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email: string;
  };
}

// --- Load Firebase Project ID for ID Token Verification (needs no IAM) ---
const firebaseConfigPath = path.resolve(__dirname, 'firebase-applet-config.json');
let firebaseProjectId = '';
if (fs.existsSync(firebaseConfigPath)) {
  const rawConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf-8')) as FirebaseConfigFile;
  firebaseProjectId = rawConfig.projectId || '';
}

const adminApp = getApps().length
  ? getApp()
  : initializeApp(firebaseProjectId ? { projectId: firebaseProjectId } : {});
const adminAuth = getAuth(adminApp);

// --- Server-Side Gemini Client ---
function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// --- Auth Middleware ---
async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Bearer authorization token.' });
      return;
    }
    const idToken = authHeader.slice('Bearer '.length).trim();
    if (!idToken) {
      res.status(401).json({ error: 'Empty authorization token.' });
      return;
    }
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!decoded.email || decoded.email_verified !== true) {
      res.status(403).json({ error: 'Verified email identity is required.' });
      return;
    }
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
    };
    next();
  } catch (error) {
    console.error('Auth verification failed:', error instanceof Error ? error.message : String(error));
    res.status(401).json({ error: 'Invalid or expired authentication session. Please sign in again.' });
  }
}

// --- PII Redaction Utility ---
function redactPiiText(input: string): { text: string; redactedCount: number } {
  let count = 0;
  let output = input;

  output = output.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, () => {
    count += 1;
    return '[REDACTED_EMAIL]';
  });

  output = output.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => {
    count += 1;
    return '[REDACTED_SSN]';
  });

  output = output.replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, () => {
    count += 1;
    return '[REDACTED_PHONE]';
  });

  output = output.replace(/\b(?:\d[ -]*?){13,16}\b/g, () => {
    count += 1;
    return '[REDACTED_CARD]';
  });

  return { text: output, redactedCount: count };
}

// --- Chunking Utility ---
function chunkPages(pages: Array<{ pageNumber: number; text: string }>): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  const maxChunkChars = 2200;
  const overlapChars = 200;
  let chunkIndex = 0;

  for (const page of pages) {
    const cleanText = page.text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
    if (!cleanText) {
      continue;
    }

    const firstLine = cleanText.split('\n').find((line) => line.trim().length > 0)?.trim() || `Page ${page.pageNumber}`;
    const sectionTitle = firstLine.slice(0, 120);

    if (cleanText.length <= maxChunkChars) {
      chunks.push({
        chunkIndex,
        pageNumber: page.pageNumber,
        sectionTitle,
        text: cleanText,
        charCount: cleanText.length,
      });
      chunkIndex += 1;
      continue;
    }

    let cursor = 0;
    while (cursor < cleanText.length) {
      let end = Math.min(cursor + maxChunkChars, cleanText.length);
      if (end < cleanText.length) {
        const lastBreak = cleanText.lastIndexOf('\n', end);
        const lastSpace = cleanText.lastIndexOf(' ', end);
        if (lastBreak > cursor + 800) {
          end = lastBreak;
        } else if (lastSpace > cursor + 800) {
          end = lastSpace;
        }
      }
      const slice = cleanText.slice(cursor, end).trim();
      if (slice.length > 0) {
        chunks.push({
          chunkIndex,
          pageNumber: page.pageNumber,
          sectionTitle,
          text: slice,
          charCount: slice.length,
        });
        chunkIndex += 1;
      }
      if (end >= cleanText.length) {
        break;
      }
      cursor = Math.max(end - overlapChars, cursor + 1);
    }
  }

  return chunks;
}

// --- PDF Extraction (pdfjs-dist + OCR fallback) ---
async function extractPdfPages(buffer: Buffer): Promise<{ pages: Array<{ pageNumber: number; text: string }>; method: string }> {
  let extractedPages: Array<{ pageNumber: number; text: string }> = [];

  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const workerPath = path.resolve(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
    if (fs.existsSync(workerPath)) {
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).toString();
    }

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0,
      useSystemFonts: true,
      disableFontFace: true,
      useWorkerFetch: false,
    });

    const pdfDoc = await loadingTask.promise;

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum += 1) {
      const page = await pdfDoc.getPage(pageNum);
      const content = await page.getTextContent();
      let pageText = '';
      let lastY: number | null = null;

      for (const item of content.items) {
        if ('str' in item) {
          const currentY = Array.isArray(item.transform) ? item.transform[5] : null;
          if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 5) {
            pageText += '\n';
          } else if (pageText.length > 0 && !pageText.endsWith(' ') && !pageText.endsWith('\n')) {
            pageText += ' ';
          }
          pageText += item.str;
          lastY = currentY;
        }
      }

      extractedPages.push({
        pageNumber: pageNum,
        text: pageText.trim(),
      });
    }
  } catch (pdfErr) {
    console.warn('pdfjs extraction failed, falling back to Gemini PDF transcription:', pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
    extractedPages = [];
  }

  const totalExtractedChars = extractedPages.reduce((sum, p) => sum + p.text.length, 0);

  if (totalExtractedChars >= 30) {
    return {
      pages: extractedPages.filter((p) => p.text.length > 0),
      method: 'pdfjs-text-layer',
    };
  }

  // Fallback for scanned / image-only PDFs using Gemini verbatim transcription
  const ai = getGeminiClient();
  const base64Pdf = buffer.toString('base64');
  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: base64Pdf,
          },
        },
        {
          text: 'Transcribe all visible text in this PDF page by page verbatim. Do not summarize, paraphrase, interpret, or invent any text not printed in the document.',
        },
      ],
    },
    config: {
      systemInstruction:
        'You are a deterministic OCR transcription engine. Output ONLY text visibly printed in the document, organized by pageNumber.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          pages: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                pageNumber: { type: Type.INTEGER },
                text: { type: Type.STRING },
              },
              required: ['pageNumber', 'text'],
            },
          },
        },
        required: ['pages'],
      },
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  });

  const parsed = JSON.parse((response.text ?? '{"pages":[]}').trim()) as {
    pages: Array<{ pageNumber: number; text: string }>;
  };

  return {
    pages: (parsed.pages || []).filter((p) => p.text && p.text.trim().length > 0),
    method: 'gemini-ocr-verbatim',
  };
}

// --- SSRF Guard for External Connectors ---
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
      return true;
    }
    return false;
  }
  return true;
}

async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs are permitted.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new Error('Internal or loopback hostnames are blocked.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('Private IP addresses are blocked.');
    }
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true });
  if (!records || records.length === 0) {
    throw new Error('Could not resolve external hostname.');
  }
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error('External hostname resolved to a restricted private network address.');
    }
  }
  return parsed;
}

// --- Retrieval & Quote Verification Helpers ---
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function lexicalScore(query: string, text: string): number {
  const terms = normalizeForMatch(query)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return 0;
  const hay = normalizeForMatch(text);
  let score = 0;
  for (const term of terms) {
    if (hay.includes(term)) {
      score += 1;
    }
  }
  return score / terms.length;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function verifyQuoteInCorpus(quote: string, docTexts: string[]): boolean {
  const normQuote = normalizeForMatch(quote);
  if (normQuote.length < 6) {
    return false;
  }
  for (const text of docTexts) {
    const normText = normalizeForMatch(text);
    if (normText.includes(normQuote)) {
      return true;
    }
    // Check 28-character anchor window in case the model joined a line wrap
    if (normQuote.length >= 28) {
      const startAnchor = normQuote.slice(0, 28);
      const endAnchor = normQuote.slice(-28);
      if (normText.includes(startAnchor) || normText.includes(endAnchor)) {
        return true;
      }
    }
  }
  return false;
}

async function processDocumentBuffer(originalName: string, buffer: Buffer) {
  const ext = path.extname(originalName).toLowerCase();
  const allowedExts = new Set(['.pdf', '.txt', '.md', '.csv', '.json']);
  if (!allowedExts.has(ext)) {
    throw Object.assign(new Error('Unsupported file format. Upload PDF, TXT, MD, CSV, or JSON.'), { status: 400 });
  }

  let pages: Array<{ pageNumber: number; text: string }> = [];
  let extractionMethod = 'plain-text';
  let fileType: 'pdf' | 'txt' | 'md' | 'csv' | 'json' = 'txt';

  if (ext === '.pdf') {
    fileType = 'pdf';
    const extracted = await extractPdfPages(buffer);
    pages = extracted.pages;
    extractionMethod = extracted.method;
  } else {
    if (ext === '.md') fileType = 'md';
    else if (ext === '.csv') fileType = 'csv';
    else if (ext === '.json') fileType = 'json';
    const rawText = buffer.toString('utf-8').trim();
    if (rawText) {
      const pageSize = 4000;
      for (let i = 0; i < rawText.length; i += pageSize) {
        pages.push({
          pageNumber: Math.floor(i / pageSize) + 1,
          text: rawText.slice(i, i + pageSize),
        });
      }
    }
  }

  const chunks = chunkPages(pages);
  if (chunks.length === 0) {
    throw Object.assign(
      new Error('No readable text could be extracted from this file. Please ensure the PDF or document contains legible text.'),
      { status: 422 }
    );
  }

  return {
    fileName: originalName,
    fileType,
    fileSize: buffer.length,
    pageCount: Math.max(pages.length, 1),
    extractionMethod,
    chunks,
  };
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '30mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 20 * 1024 * 1024,
    },
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // --- Route 1a: Parse Uploaded PDF / Document (Multipart FormData) ---
  app.post(
    '/api/documents/parse',
    requireAuth,
    upload.single('file'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const file = req.file;
        if (!file) {
          res.status(400).json({ error: 'No document file uploaded.' });
          return;
        }
        const result = await processDocumentBuffer(file.originalname || 'document', file.buffer);
        res.json(result);
      } catch (error) {
        console.error('Document parse error:', error);
        const status = typeof (error as { status?: number })?.status === 'number' ? (error as { status: number }).status : 500;
        res.status(status).json({
          error: error instanceof Error ? error.message : 'Failed to parse uploaded document.',
        });
      }
    }
  );

  // --- Route 1b: Parse Uploaded PDF / Document (JSON Base64 Fallback) ---
  app.post(
    '/api/documents/parse-base64',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { fileName, base64Data } = req.body as { fileName?: string; base64Data?: string };
        if (!fileName || !base64Data) {
          res.status(400).json({ error: 'Missing fileName or base64Data.' });
          return;
        }
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) {
          res.status(400).json({ error: 'Document size must be between 1 byte and 20 MB.' });
          return;
        }
        const result = await processDocumentBuffer(fileName, buffer);
        res.json(result);
      } catch (error) {
        console.error('Document parse-base64 error:', error);
        const status = typeof (error as { status?: number })?.status === 'number' ? (error as { status: number }).status : 500;
        res.status(status).json({
          error: error instanceof Error ? error.message : 'Failed to parse uploaded document.',
        });
      }
    }
  );

  // --- Route 2: Fetch & Ingest from External Connector ---
  app.post('/api/connectors/fetch', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { url, rawContent, title } = req.body as {
        url?: string;
        rawContent?: string;
        title?: string;
      };

      let textBody = '';
      let resolvedTitle = (title || 'Synced Knowledge Record').trim().slice(0, 180);

      if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
        textBody = rawContent.trim();
      } else if (typeof url === 'string' && url.trim().length > 0) {
        const safeUrl = await assertSafeExternalUrl(url.trim());
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const upstream = await fetch(safeUrl.toString(), {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              Accept: 'application/json, text/plain, text/markdown, text/html',
              'User-Agent': 'SolitizKnowledgeConnector/1.0',
            },
          });

          if (upstream.status >= 300 && upstream.status < 400) {
            res.status(400).json({ error: 'Redirect responses are blocked by connector security policy.' });
            return;
          }
          if (!upstream.ok) {
            res.status(502).json({ error: `Upstream connector returned HTTP ${upstream.status}.` });
            return;
          }

          const rawBytes = await upstream.text();
          if (rawBytes.length > 2 * 1024 * 1024) {
            res.status(413).json({ error: 'External payload exceeds 2 MB connector limit.' });
            return;
          }

          const contentType = upstream.headers.get('content-type') || '';
          if (contentType.includes('text/html')) {
            const titleMatch = rawBytes.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (titleMatch && !title) {
              resolvedTitle = titleMatch[1].trim().slice(0, 180);
            }
            textBody = rawBytes
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
          } else {
            textBody = rawBytes.trim();
          }
        } finally {
          clearTimeout(timer);
        }
      } else {
        res.status(400).json({ error: 'Provide either an external connector URL or content payload to sync.' });
        return;
      }

      const pages: Array<{ pageNumber: number; text: string }> = [];
      const pageSize = 4000;
      for (let i = 0; i < textBody.length; i += pageSize) {
        pages.push({
          pageNumber: Math.floor(i / pageSize) + 1,
          text: textBody.slice(i, i + pageSize),
        });
      }

      const chunks = chunkPages(pages);
      if (chunks.length === 0) {
        res.status(422).json({ error: 'Connector returned empty content.' });
        return;
      }

      res.json({
        title: resolvedTitle,
        pageCount: pages.length,
        fileSize: Buffer.byteLength(textBody, 'utf-8'),
        chunks,
      });
    } catch (error) {
      console.error('Connector fetch error:', error);
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Connector sync failed.',
      });
    }
  });

async function runGroundedAsk(
  question: string,
  chunks: AuthorizedChunkInput[]
): Promise<{
  answeredFromDocuments: boolean;
  summary: string;
  sections: AskStructuredSection[];
  answer: string;
  abstentionReason: string;
  citations: AskCitation[];
  rawCitationCount: number;
  verifiedCitationCount: number;
  piiRedactedCount: number;
  chunksScanned: number;
  latencyMs: number;
}> {
  const startedAt = Date.now();

  if (!Array.isArray(chunks) || chunks.length === 0) {
    return {
      answeredFromDocuments: false,
      summary: '',
      sections: [],
      answer:
        'No authorized AI-enabled document excerpts were available to search. Upload a document or ensure "Allow AI Query" is enabled on your authorized documents.',
      abstentionReason: 'No permitted document chunks available in scope.',
      citations: [],
      rawCitationCount: 0,
      verifiedCitationCount: 0,
      piiRedactedCount: 0,
      chunksScanned: 0,
      latencyMs: Date.now() - startedAt,
    };
  }

  let totalRedactedCount = 0;
  const sanitizedChunks = chunks
    .filter((c) => c && typeof c.docId === 'string' && typeof c.text === 'string' && c.text.trim().length > 0)
    .slice(0, 200)
    .map((c) => {
      if (c.redactPiiOnTransmit) {
        const redacted = redactPiiText(c.text);
        totalRedactedCount += redacted.redactedCount;
        return { ...c, text: redacted.text };
      }
      return c;
    });

  if (sanitizedChunks.length === 0) {
    throw Object.assign(new Error('No valid document chunks supplied.'), { status: 400 });
  }

  const ai = getGeminiClient();

  const totalChars = sanitizedChunks.reduce((sum, c) => sum + c.text.length, 0);
  let selectedChunks = sanitizedChunks;

  if (sanitizedChunks.length > 24 || totalChars > 48000) {
    const lexicalRanked = sanitizedChunks
      .map((chunk, idx) => ({
        chunk,
        idx,
        lex: lexicalScore(question, `${chunk.documentTitle} ${chunk.text}`),
      }))
      .sort((a, b) => b.lex - a.lex);

    const candidatePool = lexicalRanked.slice(0, 40).map((item) => item.chunk);

    try {
      const embedResp = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: [question, ...candidatePool.map((c) => c.text.slice(0, 2000))],
      });
      const embeddings = embedResp.embeddings || [];
      const queryVec = embeddings[0]?.values || [];
      if (queryVec.length > 0 && embeddings.length === candidatePool.length + 1) {
        selectedChunks = candidatePool
          .map((chunk, i) => {
            const vec = embeddings[i + 1]?.values || [];
            const sim = cosineSimilarity(queryVec, vec);
            const lex = lexicalScore(question, chunk.text);
            return { chunk, score: sim * 0.75 + lex * 0.25 };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 20)
          .map((item) => item.chunk);
      } else {
        selectedChunks = candidatePool.slice(0, 20);
      }
    } catch (embedErr) {
      console.warn(
        'Embedding ranking fallback to lexical ranking:',
        embedErr instanceof Error ? embedErr.message : String(embedErr)
      );
      selectedChunks = candidatePool.slice(0, 20);
    }
  }

  const corpusByDoc = new Map<string, string[]>();
  for (const c of selectedChunks) {
    const list = corpusByDoc.get(c.docId) || [];
    list.push(c.text);
    corpusByDoc.set(c.docId, list);
  }

  const formattedExcerpts = selectedChunks
    .map(
      (c, idx) =>
        `[EXCERPT ${idx + 1}] docId="${c.docId}" | documentTitle="${c.documentTitle}" | pageNumber=${c.pageNumber}\n${c.text}`
    )
    .join('\n\n---\n\n');

  const systemInstruction = [
    'You are a strict, zero-hallucination enterprise document verification assistant.',
    'Your ONLY source of truth is the DOCUMENT_EXCERPTS provided in the prompt.',
    'STRICT RULES:',
    '1. Answer ONLY with facts explicitly stated in DOCUMENT_EXCERPTS. Never use general knowledge, assumptions, or external facts.',
    '2. If the answer is NOT explicitly written in DOCUMENT_EXCERPTS, or if the excerpts are insufficient to answer accurately, you MUST set answeredFromDocuments to false, summary to "", sections to [], set answer to "Not found in the uploaded document(s). The provided authorized documents do not contain information to answer this question.", provide a concise abstentionReason, and return citations: [].',
    '3. Never guess dates, numbers, names, clauses, or definitions that are not explicitly printed in DOCUMENT_EXCERPTS.',
    '4. When answeredFromDocuments is true, produce a clear well-structured executive response: provide a crisp 1-2 sentence summary, 1 to 3 thematic sections with concise bullet points, a plain-text combined answer, and verbatim exactQuote citations copied character-for-character from DOCUMENT_EXCERPTS with exact docId, documentTitle, and pageNumber.',
  ].join('\n');

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `QUESTION:\n${question.trim()}\n\nDOCUMENT_EXCERPTS:\n${formattedExcerpts}`,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      seed: 42,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          answeredFromDocuments: {
            type: Type.BOOLEAN,
            description: 'True ONLY if the answer is explicitly stated in DOCUMENT_EXCERPTS.',
          },
          summary: {
            type: Type.STRING,
            description: '1-2 sentence executive takeaway grounded strictly in DOCUMENT_EXCERPTS.',
          },
          sections: {
            type: Type.ARRAY,
            description: 'Structured thematic headings and concise bullet points strictly grounded in DOCUMENT_EXCERPTS.',
            items: {
              type: Type.OBJECT,
              properties: {
                heading: { type: Type.STRING },
                points: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
              required: ['heading', 'points'],
            },
          },
          answer: {
            type: Type.STRING,
            description: 'Grounded answer strictly derived from DOCUMENT_EXCERPTS, or explicit abstention message.',
          },
          abstentionReason: {
            type: Type.STRING,
            description: 'Empty string if answered; otherwise short reason why the documents do not support answering.',
          },
          citations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                docId: { type: Type.STRING },
                documentTitle: { type: Type.STRING },
                pageNumber: { type: Type.INTEGER },
                exactQuote: {
                  type: Type.STRING,
                  description: 'Exact verbatim quote copied from DOCUMENT_EXCERPTS supporting the answer.',
                },
              },
              required: ['docId', 'documentTitle', 'pageNumber', 'exactQuote'],
            },
          },
        },
        required: ['answeredFromDocuments', 'summary', 'sections', 'answer', 'abstentionReason', 'citations'],
      },
    },
  });

  const rawJson = (response.text ?? '').trim();
  const parsed = JSON.parse(rawJson) as AskModelPayload;
  const rawCitations = Array.isArray(parsed.citations) ? parsed.citations : [];

  const verifiedCitations = rawCitations.filter((cit) => {
    const docTexts = corpusByDoc.get(cit.docId);
    if (!docTexts) return false;
    return verifyQuoteInCorpus(cit.exactQuote, docTexts);
  });

  const latencyMs = Date.now() - startedAt;

  if (!parsed.answeredFromDocuments || verifiedCitations.length === 0) {
    return {
      answeredFromDocuments: false,
      summary: '',
      sections: [],
      answer:
        'Not found in the uploaded document(s). The provided authorized documents do not contain verifiable information to answer this question.',
      abstentionReason:
        parsed.abstentionReason ||
        'No verbatim supporting passage matched the query within your authorized documents.',
      citations: [],
      rawCitationCount: rawCitations.length,
      verifiedCitationCount: verifiedCitations.length,
      piiRedactedCount: totalRedactedCount,
      chunksScanned: selectedChunks.length,
      latencyMs,
    };
  }

  const cleanSections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .filter((s) => s && typeof s.heading === 'string' && Array.isArray(s.points) && s.points.length > 0)
    .map((s) => ({
      heading: s.heading.trim(),
      points: s.points.map((p) => String(p).trim()).filter(Boolean),
    }));

  return {
    answeredFromDocuments: true,
    summary: (parsed.summary || '').trim(),
    sections: cleanSections,
    answer: parsed.answer,
    abstentionReason: '',
    citations: verifiedCitations,
    rawCitationCount: rawCitations.length,
    verifiedCitationCount: verifiedCitations.length,
    piiRedactedCount: totalRedactedCount,
    chunksScanned: selectedChunks.length,
    latencyMs,
  };
}

  // --- Route 3: Zero-Hallucination Grounded Q&A ---
  app.post('/api/ask', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { question, chunks } = req.body as {
        question?: string;
        chunks?: AuthorizedChunkInput[];
      };

      if (typeof question !== 'string' || question.trim().length === 0 || question.length > 1000) {
        res.status(400).json({ error: 'Please enter a valid question (1 to 1000 characters).' });
        return;
      }

      const result = await runGroundedAsk(question, chunks || []);
      res.json({
        answeredFromDocuments: result.answeredFromDocuments,
        summary: result.summary,
        sections: result.sections,
        answer: result.answer,
        abstentionReason: result.abstentionReason,
        citations: result.citations,
        piiRedactedCount: result.piiRedactedCount,
        chunksScanned: result.chunksScanned,
        latencyMs: result.latencyMs,
      });
    } catch (error) {
      console.error('Ask endpoint error:', error);
      const status = typeof (error as { status?: number })?.status === 'number' ? (error as { status: number }).status : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : 'Failed to process grounded document query.',
      });
    }
  });

  // --- Route 4: AI Evaluation Suite ---
  app.post('/api/evaluate', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { testCases, chunks } = req.body as {
        testCases?: EvaluationCasePayload[];
        chunks?: AuthorizedChunkInput[];
      };

      if (!Array.isArray(testCases) || testCases.length === 0) {
        res.status(400).json({ error: 'Provide at least 1 evaluation test case.' });
        return;
      }

      if (!Array.isArray(chunks) || chunks.length === 0) {
        res.status(400).json({ error: 'Upload or select at least 1 authorized AI-enabled document before running evaluation.' });
        return;
      }

      const boundedCases = testCases.slice(0, 8);
      const results: Array<{
        id: string;
        question: string;
        expectedBehavior: 'must_answer' | 'must_abstain';
        passed: boolean;
        answeredFromDocuments: boolean;
        summary: string;
        answer: string;
        citationCount: number;
        verifiedCitationCount: number;
        latencyMs: number;
        diagnostic: string;
      }> = [];

      let totalRawCitations = 0;
      let totalVerifiedCitations = 0;
      let totalLatency = 0;
      let totalRedactedPii = 0;

      for (const tc of boundedCases) {
        const questionText = typeof tc.question === 'string' ? tc.question.trim() : '';
        if (!questionText) continue;

        const outcome = await runGroundedAsk(questionText, chunks);
        totalRawCitations += outcome.rawCitationCount;
        totalVerifiedCitations += outcome.verifiedCitationCount;
        totalLatency += outcome.latencyMs;
        totalRedactedPii += outcome.piiRedactedCount;

        let passed = false;
        let diagnostic = '';

        if (tc.expectedBehavior === 'must_abstain') {
          passed = !outcome.answeredFromDocuments && outcome.verifiedCitationCount === 0;
          diagnostic = passed
            ? 'Correctly abstained with zero fabricated claims or citations.'
            : 'Failed abstention check: generated an answer on out-of-scope query.';
        } else {
          const keywords = (tc.expectedKeywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean);
          const hay = `${outcome.summary} ${outcome.answer}`.toLowerCase();
          const missingKeywords = keywords.filter((kw) => !hay.includes(kw));

          if (!outcome.answeredFromDocuments || outcome.verifiedCitationCount === 0) {
            passed = false;
            diagnostic = 'Failed grounding check: could not answer or verify verbatim page citation.';
          } else if (missingKeywords.length > 0) {
            passed = false;
            diagnostic = `Answered with ${outcome.verifiedCitationCount} citation(s), but missed expected term(s): ${missingKeywords.join(', ')}.`;
          } else {
            passed = true;
            diagnostic = `Grounded answer verified with ${outcome.verifiedCitationCount} verbatim page citation(s).`;
          }
        }

        results.push({
          id: tc.id,
          question: questionText,
          expectedBehavior: tc.expectedBehavior,
          passed,
          answeredFromDocuments: outcome.answeredFromDocuments,
          summary: outcome.summary,
          answer: outcome.answer,
          citationCount: outcome.rawCitationCount,
          verifiedCitationCount: outcome.verifiedCitationCount,
          latencyMs: outcome.latencyMs,
          diagnostic,
        });
      }

      const answerCases = results.filter((r) => r.expectedBehavior === 'must_answer');
      const abstainCases = results.filter((r) => r.expectedBehavior === 'must_abstain');

      const groundingFaithfulnessScore =
        answerCases.length > 0
          ? Math.round((answerCases.filter((r) => r.passed).length / answerCases.length) * 100)
          : 100;

      const hallucinationRejectionScore =
        abstainCases.length > 0
          ? Math.round((abstainCases.filter((r) => r.passed).length / abstainCases.length) * 100)
          : 100;

      const citationPrecisionScore =
        totalRawCitations > 0
          ? Math.round((totalVerifiedCitations / totalRawCitations) * 100)
          : results.every((r) => r.passed)
            ? 100
            : 0;

      const passedCases = results.filter((r) => r.passed).length;
      const overallScore =
        results.length > 0 ? Math.round((passedCases / results.length) * 100) : 0;

      res.json({
        overallScore,
        groundingFaithfulnessScore,
        hallucinationRejectionScore,
        citationPrecisionScore,
        avgLatencyMs: results.length > 0 ? Math.round(totalLatency / results.length) : 0,
        totalCases: results.length,
        passedCases,
        totalRedactedPii,
        evaluatedAt: new Date().toISOString(),
        results,
      });
    } catch (error) {
      console.error('Evaluate endpoint error:', error);
      const status = typeof (error as { status?: number })?.status === 'number' ? (error as { status: number }).status : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : 'Failed to run AI evaluation suite.',
      });
    }
  });

  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('API middleware error:', err);
    const msg = err instanceof Error ? err.message : 'Unexpected server error.';
    res.status(400).json({ error: msg });
  });

  // --- Vite Middleware / Static Serving ---
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Solitiz Enterprise Knowledge server running on http://0.0.0.0:${port}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
