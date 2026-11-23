import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { AlertCircle, ArrowRight, BarChart3, ShieldCheck, Upload } from 'lucide-react';
import type { AuditLogEntry, SearchAnalyticEvent } from '../types';

interface SearchTrendsViewProps {
  searchEvents: SearchAnalyticEvent[];
  auditLogs: AuditLogEntry[];
  onGoToAsk: () => void;
  onOpenUpload: () => void;
}

interface NormalizedTrendRecord {
  id: string;
  normalizedQuery: string;
  rawQuery: string;
  department: string;
  outcome: 'answered' | 'knowledge_gap';
  citationCount: number;
  timestampMs: number;
}

interface QueryAggregate {
  normalizedQuery: string;
  displayQuery: string;
  department: string;
  total: number;
  answered: number;
  gaps: number;
  lastAskedMs: number;
}

interface TimeBucket {
  label: string;
  sortKey: number;
  total: number;
  gaps: number;
}

function parseLegacyAuditLogs(logs: AuditLogEntry[]): NormalizedTrendRecord[] {
  const results: NormalizedTrendRecord[] = [];
  for (const log of logs) {
    if (log.action !== 'ai_query' && log.action !== 'ai_abstain') continue;
    const match = log.details.match(/Query:\s*"([^"]+)"/);
    const rawQuery = match?.[1]?.trim() || log.targetTitle || 'Enterprise query';
    const normalized = rawQuery
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const citMatch = log.details.match(/Citations:\s*(\d+)/);
    const citationCount = citMatch ? Number(citMatch[1]) : 0;
    results.push({
      id: `audit_${log.id}`,
      normalizedQuery: normalized || rawQuery.toLowerCase(),
      rawQuery,
      department: log.actorRole || 'General',
      outcome: log.action === 'ai_query' ? 'answered' : 'knowledge_gap',
      citationCount,
      timestampMs: log.createdAt?.toMillis?.() || Date.now(),
    });
  }
  return results;
}

export function SearchTrendsView({
  searchEvents,
  auditLogs,
  onGoToAsk,
  onOpenUpload,
}: SearchTrendsViewProps) {
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | 'answered' | 'knowledge_gap'>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');
  const [hoveredTopic, setHoveredTopic] = useState<{
    query: string;
    total: number;
    answered: number;
    gaps: number;
  } | null>(null);
  const [hoveredBucket, setHoveredBucket] = useState<TimeBucket | null>(null);

  const barContainerRef = useRef<HTMLDivElement>(null);
  const barSvgRef = useRef<SVGSVGElement>(null);
  const lineContainerRef = useRef<HTMLDivElement>(null);
  const lineSvgRef = useRef<SVGSVGElement>(null);

  const [barWidth, setBarWidth] = useState(640);
  const [lineWidth, setLineWidth] = useState(520);

  // Combine searchAnalytics with any legacy auditLog AI events not yet in searchAnalytics
  const allRecords = useMemo<NormalizedTrendRecord[]>(() => {
    const primary: NormalizedTrendRecord[] = searchEvents.map((ev) => ({
      id: ev.id,
      normalizedQuery: ev.normalizedQuery,
      rawQuery: ev.rawQuery,
      department: ev.department,
      outcome: ev.outcome,
      citationCount: ev.citationCount,
      timestampMs: ev.createdAt?.toMillis?.() || Date.now(),
    }));

    if (primary.length > 0) {
      return primary;
    }
    return parseLegacyAuditLogs(auditLogs);
  }, [searchEvents, auditLogs]);

  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRecords) {
      if (r.department) set.add(r.department);
    }
    return Array.from(set).sort();
  }, [allRecords]);

  const filteredRecords = useMemo(() => {
    return allRecords.filter((r) => {
      if (outcomeFilter !== 'all' && r.outcome !== outcomeFilter) return false;
      if (departmentFilter !== 'all' && r.department !== departmentFilter) return false;
      return true;
    });
  }, [allRecords, outcomeFilter, departmentFilter]);

  const aggregatedTopics = useMemo<QueryAggregate[]>(() => {
    const map = new Map<string, QueryAggregate>();
    for (const rec of filteredRecords) {
      const key = rec.normalizedQuery || rec.rawQuery.toLowerCase();
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          normalizedQuery: key,
          displayQuery: rec.rawQuery,
          department: rec.department,
          total: 1,
          answered: rec.outcome === 'answered' ? 1 : 0,
          gaps: rec.outcome === 'knowledge_gap' ? 1 : 0,
          lastAskedMs: rec.timestampMs,
        });
      } else {
        existing.total += 1;
        if (rec.outcome === 'answered') existing.answered += 1;
        else existing.gaps += 1;
        if (rec.timestampMs > existing.lastAskedMs) {
          existing.lastAskedMs = rec.timestampMs;
          existing.displayQuery = rec.rawQuery;
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total || b.gaps - a.gaps);
  }, [filteredRecords]);

  const topTopicsForChart = useMemo(() => aggregatedTopics.slice(0, 10), [aggregatedTopics]);

  const knowledgeGaps = useMemo(
    () =>
      aggregatedTopics
        .filter((t) => t.gaps > 0)
        .sort((a, b) => b.gaps - a.gaps || b.total - a.total),
    [aggregatedTopics]
  );

  const timeBuckets = useMemo<TimeBucket[]>(() => {
    if (filteredRecords.length === 0) return [];
    const timestamps = filteredRecords.map((r) => r.timestampMs);
    const spanMs = Math.max(...timestamps) - Math.min(...timestamps);
    const useHourly = spanMs <= 48 * 60 * 60 * 1000;

    const map = new Map<string, TimeBucket>();
    for (const rec of filteredRecords) {
      const d = new Date(rec.timestampMs);
      const label = useHourly
        ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`
        : `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
      const bucketKey = useHourly
        ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
        : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

      const existing = map.get(String(bucketKey));
      if (!existing) {
        map.set(String(bucketKey), {
          label,
          sortKey: bucketKey,
          total: 1,
          gaps: rec.outcome === 'knowledge_gap' ? 1 : 0,
        });
      } else {
        existing.total += 1;
        if (rec.outcome === 'knowledge_gap') existing.gaps += 1;
      }
    }

    return Array.from(map.values()).sort((a, b) => a.sortKey - b.sortKey);
  }, [filteredRecords]);

  const totalQueries = filteredRecords.length;
  const totalGaps = filteredRecords.filter((r) => r.outcome === 'knowledge_gap').length;
  const answerRate = totalQueries > 0 ? Math.round(((totalQueries - totalGaps) / totalQueries) * 100) : 0;

  // Responsive ResizeObserver for D3 SVGs
  useEffect(() => {
    const observers: ResizeObserver[] = [];
    if (barContainerRef.current) {
      const obs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0) {
            setBarWidth(Math.floor(entry.contentRect.width));
          }
        }
      });
      obs.observe(barContainerRef.current);
      observers.push(obs);
    }
    if (lineContainerRef.current) {
      const obs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0) {
            setLineWidth(Math.floor(entry.contentRect.width));
          }
        }
      });
      obs.observe(lineContainerRef.current);
      observers.push(obs);
    }
    return () => observers.forEach((o) => o.disconnect());
  }, [filteredRecords.length]);

  // Render D3 Stacked Horizontal Bar Chart
  useEffect(() => {
    const svgEl = barSvgRef.current;
    if (!svgEl || topTopicsForChart.length === 0) return;

    const margin = { top: 12, right: 24, bottom: 32, left: 210 };
    const rowHeight = 34;
    const innerHeight = Math.max(160, topTopicsForChart.length * rowHeight);
    const height = innerHeight + margin.top + margin.bottom;
    const width = Math.max(360, barWidth);
    const innerWidth = Math.max(120, width - margin.left - margin.right);

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const maxTotal = d3.max(topTopicsForChart, (d) => d.total) || 1;
    const x = d3.scaleLinear().domain([0, maxTotal]).nice().range([0, innerWidth]);

    const y = d3
      .scaleBand<string>()
      .domain(topTopicsForChart.map((d) => d.normalizedQuery))
      .range([0, innerHeight])
      .padding(0.28);

    // Subtle vertical gridlines
    g.append('g')
      .attr('class', 'grid')
      .call(
        d3
          .axisBottom(x)
          .ticks(Math.min(maxTotal, 5))
          .tickSize(innerHeight)
          .tickFormat(() => '')
      )
      .call((sel) => sel.select('.domain').remove())
      .call((sel) => sel.selectAll('line').attr('stroke', '#e2e8f0').attr('stroke-dasharray', '2,2'));

    // X Axis
    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x).ticks(Math.min(maxTotal, 5)).tickFormat(d3.format('d')))
      .call((sel) => sel.select('.domain').attr('stroke', '#cbd5e1'))
      .call((sel) =>
        sel
          .selectAll('text')
          .attr('fill', '#64748b')
          .style('font-size', '11px')
          .style('font-family', 'JetBrains Mono, monospace')
      );

    // Y Axis with truncated query labels
    const labelMap = new Map(topTopicsForChart.map((d) => [d.normalizedQuery, d.displayQuery]));
    g.append('g')
      .call(
        d3.axisLeft(y).tickFormat((key) => {
          const full = labelMap.get(key) || key;
          return full.length > 28 ? `${full.slice(0, 27)}…` : full;
        })
      )
      .call((sel) => sel.select('.domain').attr('stroke', '#cbd5e1'))
      .call((sel) =>
        sel
          .selectAll('text')
          .attr('fill', '#0f172a')
          .style('font-size', '11.5px')
          .style('font-family', 'DM Sans, sans-serif')
      );

    // Stack Answered + Knowledge Gaps
    const stackGen = d3.stack<QueryAggregate>().keys(['answered', 'gaps']);
    const series = stackGen(topTopicsForChart);
    const colorScale = d3
      .scaleOrdinal<string, string>()
      .domain(['answered', 'gaps'])
      .range(['#059669', '#D97706']);

    const layer = g
      .selectAll('.stack-layer')
      .data(series)
      .join('g')
      .attr('class', 'stack-layer')
      .attr('fill', (d) => colorScale(d.key));

    layer
      .selectAll('rect')
      .data((d) => d)
      .join('rect')
      .attr('y', (d) => y(d.data.normalizedQuery) ?? 0)
      .attr('x', (d) => x(d[0]))
      .attr('width', (d) => Math.max(0, x(d[1]) - x(d[0])))
      .attr('height', y.bandwidth())
      .attr('rx', 3)
      .style('cursor', 'pointer')
      .on('mouseenter', (_event, d) => {
        setHoveredTopic({
          query: d.data.displayQuery,
          total: d.data.total,
          answered: d.data.answered,
          gaps: d.data.gaps,
        });
      })
      .on('mouseleave', () => setHoveredTopic(null));
  }, [topTopicsForChart, barWidth]);

  // Render D3 Query & Gap Trend Line/Area Chart
  useEffect(() => {
    const svgEl = lineSvgRef.current;
    if (!svgEl || timeBuckets.length === 0) return;

    const margin = { top: 16, right: 20, bottom: 34, left: 38 };
    const height = 260;
    const width = Math.max(320, lineWidth);
    const innerWidth = Math.max(120, width - margin.left - margin.right);
    const innerHeight = height - margin.top - margin.bottom;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3
      .scalePoint<string>()
      .domain(timeBuckets.map((b) => b.label))
      .range([0, innerWidth])
      .padding(0.25);

    const maxY = d3.max(timeBuckets, (b) => b.total) || 1;
    const y = d3.scaleLinear().domain([0, maxY]).nice().range([innerHeight, 0]);

    // Horizontal gridlines
    g.append('g')
      .call(
        d3
          .axisLeft(y)
          .ticks(Math.min(maxY, 5))
          .tickSize(-innerWidth)
          .tickFormat(() => '')
      )
      .call((sel) => sel.select('.domain').remove())
      .call((sel) => sel.selectAll('line').attr('stroke', '#e2e8f0').attr('stroke-dasharray', '2,2'));

    // X Axis
    const tickLabels = timeBuckets.map((b) => b.label);
    const step = Math.max(1, Math.ceil(tickLabels.length / 6));
    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(
        d3.axisBottom(x).tickValues(tickLabels.filter((_val, idx) => idx % step === 0))
      )
      .call((sel) => sel.select('.domain').attr('stroke', '#cbd5e1'))
      .call((sel) =>
        sel
          .selectAll('text')
          .attr('fill', '#64748b')
          .style('font-size', '10.5px')
          .style('font-family', 'JetBrains Mono, monospace')
      );

    // Y Axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(Math.min(maxY, 5)).tickFormat(d3.format('d')))
      .call((sel) => sel.select('.domain').attr('stroke', '#cbd5e1'))
      .call((sel) =>
        sel
          .selectAll('text')
          .attr('fill', '#64748b')
          .style('font-size', '11px')
          .style('font-family', 'JetBrains Mono, monospace')
      );

    // Total queries area + line
    const totalArea = d3
      .area<TimeBucket>()
      .x((d) => x(d.label) ?? 0)
      .y0(innerHeight)
      .y1((d) => y(d.total))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(timeBuckets)
      .attr('fill', 'rgba(15, 23, 42, 0.06)')
      .attr('d', totalArea);

    const totalLine = d3
      .line<TimeBucket>()
      .x((d) => x(d.label) ?? 0)
      .y((d) => y(d.total))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(timeBuckets)
      .attr('fill', 'none')
      .attr('stroke', '#0f172a')
      .attr('stroke-width', 2)
      .attr('d', totalLine);

    // Knowledge gap line
    const gapLine = d3
      .line<TimeBucket>()
      .x((d) => x(d.label) ?? 0)
      .y((d) => y(d.gaps))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(timeBuckets)
      .attr('fill', 'none')
      .attr('stroke', '#D97706')
      .attr('stroke-width', 2)
      .attr('d', gapLine);

    // Interactive Data Points
    g.selectAll('.dot-total')
      .data(timeBuckets)
      .join('circle')
      .attr('cx', (d) => x(d.label) ?? 0)
      .attr('cy', (d) => y(d.total))
      .attr('r', 4)
      .attr('fill', '#0f172a')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('mouseenter', (_ev, d) => setHoveredBucket(d))
      .on('mouseleave', () => setHoveredBucket(null));

    g.selectAll('.dot-gap')
      .data(timeBuckets)
      .join('circle')
      .attr('cx', (d) => x(d.label) ?? 0)
      .attr('cy', (d) => y(d.gaps))
      .attr('r', 4)
      .attr('fill', '#D97706')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('mouseenter', (_ev, d) => setHoveredBucket(d))
      .on('mouseleave', () => setHoveredBucket(null));
  }, [timeBuckets, lineWidth]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Enterprise Search Trends &amp; Knowledge Gaps
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            D3.js telemetry of the most frequently queried topics and unanswered questions blocked by the zero-hallucination guard.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            aria-label="Filter by department"
            className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-800"
          >
            <option value="all">All Roles / Departments</option>
            {departments.map((dept) => (
              <option key={dept} value={dept}>
                {dept}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                { id: 'all', label: 'All Queries' },
                { id: 'answered', label: 'Answered' },
                { id: 'knowledge_gap', label: 'Knowledge Gaps' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setOutcomeFilter(opt.id)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  outcomeFilter === opt.id
                    ? 'bg-white text-slate-900'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-xl divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
        <div className="p-4">
          <div className="text-xs text-slate-500">Total Queries Logged</div>
          <div className="text-xl font-semibold text-slate-900 font-mono tabular-nums mt-1">
            {totalQueries}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Grounded Answer Rate</div>
          <div className="text-xl font-semibold text-emerald-700 font-mono tabular-nums mt-1">
            {answerRate}%
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Knowledge Gap Abstentions</div>
          <div className="text-xl font-semibold text-amber-700 font-mono tabular-nums mt-1">
            {totalGaps}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Unique Query Topics</div>
          <div className="text-xl font-semibold text-slate-900 font-mono tabular-nums mt-1">
            {aggregatedTopics.length}
          </div>
        </div>
      </div>

      {filteredRecords.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
          <BarChart3 className="w-7 h-7 text-slate-400 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-900">
            No Search Trend Data Recorded Yet
          </h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
            Run natural language queries in Search &amp; Q&amp;A. Every grounded answer and zero-hallucination abstention automatically populates the D3.js frequency and knowledge-gap charts here.
          </p>
          <button
            type="button"
            onClick={onGoToAsk}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            Go to Search &amp; Q&amp;A
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <>
          {/* D3 Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* D3 Chart 1: Stacked Horizontal Bar Chart of Frequent Queries vs Gaps */}
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Most Frequently Asked Queries
                  </h3>
                  <p className="text-xs text-slate-500">
                    Stacked by grounded answers vs. unresolved knowledge gaps
                  </p>
                </div>

                <div className="flex items-center gap-4 text-xs text-slate-600">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-emerald-600 inline-block" />
                    Answered
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-amber-600 inline-block" />
                    Knowledge Gap
                  </span>
                </div>
              </div>

              <div className="min-h-[20px] text-xs text-slate-600 font-mono tabular-nums">
                {hoveredTopic ? (
                  <span>
                    &ldquo;{hoveredTopic.query}&rdquo; — Total: {hoveredTopic.total} · Answered:{' '}
                    {hoveredTopic.answered} · Gaps: {hoveredTopic.gaps}
                  </span>
                ) : (
                  <span className="text-slate-400">Hover any bar to inspect exact query counts</span>
                )}
              </div>

              <div ref={barContainerRef} className="w-full overflow-x-auto">
                <svg ref={barSvgRef} className="block" />
              </div>
            </div>

            {/* D3 Chart 2: Query Volume vs Knowledge Gaps Over Time */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Query Volume &amp; Gap Trend
                  </h3>
                  <p className="text-xs text-slate-500">
                    Chronological volume of enterprise queries vs. gaps
                  </p>
                </div>

                <div className="flex items-center gap-4 text-xs text-slate-600">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-0.5 bg-slate-900 inline-block" />
                    Total
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-0.5 bg-amber-600 inline-block" />
                    Gaps
                  </span>
                </div>
              </div>

              <div className="min-h-[20px] text-xs text-slate-600 font-mono tabular-nums">
                {hoveredBucket ? (
                  <span>
                    {hoveredBucket.label} — Total: {hoveredBucket.total} · Knowledge Gaps:{' '}
                    {hoveredBucket.gaps}
                  </span>
                ) : (
                  <span className="text-slate-400">Hover any point for interval breakdown</span>
                )}
              </div>

              <div ref={lineContainerRef} className="w-full overflow-x-auto">
                <svg ref={lineSvgRef} className="block" />
              </div>
            </div>
          </div>

          {/* Common Knowledge Gaps Action Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-700 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Common Enterprise Knowledge Gaps
                  </h3>
                  <p className="text-xs text-slate-500">
                    Questions where no authorized document contained verifiable evidence—upload documentation to close these gaps.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={onOpenUpload}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Upload className="w-3.5 h-3.5" />
                Upload Missing Doc
              </button>
            </div>

            {knowledgeGaps.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-600 flex items-center justify-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-700" />
                <span>All logged enterprise queries in this filter were answered with verified document citations.</span>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                      <th className="py-2.5 px-4">Unresolved Query</th>
                      <th className="py-2.5 px-4">Department / Role</th>
                      <th className="py-2.5 px-4 text-right">Gap Count</th>
                      <th className="py-2.5 px-4 text-right">Total Asks</th>
                      <th className="py-2.5 px-4 text-right">Last Asked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {knowledgeGaps.map((gap) => (
                      <tr key={gap.normalizedQuery} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-4 font-medium text-slate-900 max-w-md">
                          {gap.displayQuery}
                        </td>
                        <td className="py-2.5 px-4 text-slate-600 capitalize">{gap.department}</td>
                        <td className="py-2.5 px-4 text-right font-mono font-semibold text-amber-700 tabular-nums">
                          {gap.gaps}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono text-slate-700 tabular-nums">
                          {gap.total}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono text-slate-500 tabular-nums whitespace-nowrap">
                          {new Date(gap.lastAskedMs).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
