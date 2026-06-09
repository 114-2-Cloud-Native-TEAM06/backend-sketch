import { createServer, type Server } from 'http';
import type { Express } from 'express';

type Labels = Record<string, string>;

type MetricConfiguration = {
  name: string;
  help: string;
  labelNames?: string[];
};

type HistogramConfiguration = MetricConfiguration & {
  buckets?: number[];
};

const contentType = 'text/plain; version=0.0.4; charset=utf-8';
const metrics = new Map<string, Metric>();
let defaultLabels: Labels = {};

export function setupDefaultMetrics(serviceName: string): void {
  defaultLabels = {
    service: process.env.METRICS_SERVICE_NAME || serviceName,
    instance: process.env.METRICS_INSTANCE_NAME || process.env.HOSTNAME || serviceName,
  };
}

export function installMetricsRoute(app: Express, serviceName: string): void {
  setupDefaultMetrics(serviceName);
  app.get('/metrics', (_req, res) => {
    res.set('Content-Type', contentType);
    res.end(renderMetrics());
  });
}

export function startMetricsServer(
  serviceName: string,
  port = Number(process.env.METRICS_PORT || 9090),
): Server | undefined {
  if (!Number.isFinite(port) || port <= 0) return undefined;
  setupDefaultMetrics(serviceName);
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(renderMetrics());
      return;
    }

    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => {
    console.log(`${serviceName} metrics running on port ${port}`);
  });
  return server;
}

export function getOrCreateCounter(configuration: MetricConfiguration): CounterMetric {
  return getOrCreateMetric(configuration.name, () => new CounterMetric(configuration)) as CounterMetric;
}

export function getOrCreateGauge(configuration: MetricConfiguration): GaugeMetric {
  return getOrCreateMetric(configuration.name, () => new GaugeMetric(configuration)) as GaugeMetric;
}

export function getOrCreateHistogram(configuration: HistogramConfiguration): HistogramMetric {
  return getOrCreateMetric(configuration.name, () => new HistogramMetric(configuration)) as HistogramMetric;
}

abstract class Metric {
  protected readonly labelNames: string[];
  protected readonly values = new Map<string, number>();
  protected readonly labelsByKey = new Map<string, Labels>();
  readonly name: string;
  readonly help: string;

  constructor(configuration: MetricConfiguration) {
    this.name = configuration.name;
    this.help = configuration.help;
    this.labelNames = configuration.labelNames ?? [];
  }

  abstract render(): string[];

  protected labelsForValues(values: string[]): Labels {
    const labels: Labels = { ...defaultLabels };
    for (let index = 0; index < this.labelNames.length; index += 1) {
      labels[this.labelNames[index]] = values[index] ?? '';
    }
    return labels;
  }
}

class CounterMetric extends Metric {
  inc(value = 1): void {
    this.child([]).inc(value);
  }

  labels(...values: string[]): CounterChild {
    return this.child(values);
  }

  render(): string[] {
    return [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} counter`,
      ...[...this.values.entries()].map(([key, value]) => `${this.name}${formatLabels(this.labelsByKey.get(key) ?? {})} ${value}`),
    ];
  }

  private child(values: string[]): CounterChild {
    const labels = this.labelsForValues(values);
    const key = labelsKey(labels);
    if (!this.values.has(key)) this.values.set(key, 0);
    this.labelsByKey.set(key, labels);
    return {
      inc: (value = 1) => {
        this.values.set(key, (this.values.get(key) ?? 0) + Math.max(0, value));
      },
    };
  }
}

class GaugeMetric extends Metric {
  set(value: number): void {
    this.child([]).set(value);
  }

  labels(...values: string[]): GaugeChild {
    return this.child(values);
  }

  render(): string[] {
    return [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} gauge`,
      ...[...this.values.entries()].map(([key, value]) => `${this.name}${formatLabels(this.labelsByKey.get(key) ?? {})} ${value}`),
    ];
  }

  private child(values: string[]): GaugeChild {
    const labels = this.labelsForValues(values);
    const key = labelsKey(labels);
    if (!this.values.has(key)) this.values.set(key, 0);
    this.labelsByKey.set(key, labels);
    return {
      set: (value: number) => {
        this.values.set(key, Number.isFinite(value) ? value : 0);
      },
    };
  }
}

class HistogramMetric extends Metric {
  private readonly buckets: number[];
  private readonly observations = new Map<string, HistogramObservation>();

  constructor(configuration: HistogramConfiguration) {
    super(configuration);
    this.buckets = [...new Set(configuration.buckets ?? [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000])].sort((a, b) => a - b);
  }

  observe(value: number): void {
    this.child([]).observe(value);
  }

  labels(...values: string[]): HistogramChild {
    return this.child(values);
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const [key, observation] of this.observations.entries()) {
      const baseLabels = this.labelsByKey.get(key) ?? {};
      let cumulative = 0;
      for (const bucket of this.buckets) {
        cumulative += observation.buckets.get(bucket) ?? 0;
        lines.push(`${this.name}_bucket${formatLabels({ ...baseLabels, le: String(bucket) })} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket${formatLabels({ ...baseLabels, le: '+Inf' })} ${observation.count}`);
      lines.push(`${this.name}_sum${formatLabels(baseLabels)} ${roundMetricValue(observation.sum)}`);
      lines.push(`${this.name}_count${formatLabels(baseLabels)} ${observation.count}`);
    }
    return lines;
  }

  private child(values: string[]): HistogramChild {
    const labels = this.labelsForValues(values);
    const key = labelsKey(labels);
    if (!this.observations.has(key)) {
      this.observations.set(key, { buckets: new Map(), count: 0, sum: 0 });
    }
    this.labelsByKey.set(key, labels);
    return {
      observe: (value: number) => {
        const normalized = Math.max(0, Number.isFinite(value) ? value : 0);
        const observation = this.observations.get(key)!;
        for (const bucket of this.buckets) {
          if (normalized <= bucket) {
            observation.buckets.set(bucket, (observation.buckets.get(bucket) ?? 0) + 1);
            break;
          }
        }
        observation.count += 1;
        observation.sum += normalized;
      },
    };
  }
}

type CounterChild = {
  inc(value?: number): void;
};

type GaugeChild = {
  set(value: number): void;
};

type HistogramChild = {
  observe(value: number): void;
};

type HistogramObservation = {
  buckets: Map<number, number>;
  count: number;
  sum: number;
};

function getOrCreateMetric(name: string, create: () => Metric): Metric {
  const existing = metrics.get(name);
  if (existing) return existing;
  const metric = create();
  metrics.set(name, metric);
  return metric;
}

function renderMetrics(): string {
  const processMetrics = renderProcessMetrics();
  const appMetrics = [...metrics.values()].flatMap((metric) => metric.render());
  return [...processMetrics, ...appMetrics, ''].join('\n');
}

function renderProcessMetrics(): string[] {
  const memory = process.memoryUsage();
  return [
    '# HELP backend_process_uptime_seconds Process uptime in seconds.',
    '# TYPE backend_process_uptime_seconds gauge',
    `backend_process_uptime_seconds${formatLabels(defaultLabels)} ${roundMetricValue(process.uptime())}`,
    '# HELP backend_process_resident_memory_bytes Process resident memory size in bytes.',
    '# TYPE backend_process_resident_memory_bytes gauge',
    `backend_process_resident_memory_bytes${formatLabels(defaultLabels)} ${memory.rss}`,
    '# HELP backend_process_heap_used_bytes Process heap used in bytes.',
    '# TYPE backend_process_heap_used_bytes gauge',
    `backend_process_heap_used_bytes${formatLabels(defaultLabels)} ${memory.heapUsed}`,
  ];
}

function labelsKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function roundMetricValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}
