import { SpanStatusCode, context, trace, type Attributes, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { TelemetryConfig } from "./types.ts";

let provider: NodeTracerProvider | undefined;
let started = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function endpoint(config: TelemetryConfig): string | undefined {
  return (config.endpointEnv ? process.env[config.endpointEnv] : config.endpoint)?.trim() || undefined;
}

export function initializeTelemetry(config: TelemetryConfig): void {
  if (started || !config.enabled) return;
  const traceExporter = config.exporter === "otlp"
    ? new OTLPTraceExporter({ url: endpoint(config) })
    : new ConsoleSpanExporter();
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": config.serviceName }),
    sampler: new TraceIdRatioBasedSampler(config.sampleRatio),
    spanProcessors: [config.exporter === "otlp"
      ? new BatchSpanProcessor(traceExporter)
      : new SimpleSpanProcessor(traceExporter)],
  });
  provider.register();
  started = true;
}

export async function shutdownTelemetry(): Promise<void> {
  const active = provider;
  provider = undefined;
  started = false;
  if (active) await active.shutdown();
}

export async function withTraceSpan<T>(
  name: string,
  attributes: Attributes,
  callback: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer("jevio");
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await callback(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(errorMessage(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error).slice(0, 500) });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function addTraceEvent(name: string, attributes: Attributes = {}): void {
  trace.getSpan(context.active())?.addEvent(name, attributes);
}

export function setTraceAttributes(attributes: Attributes): void {
  trace.getSpan(context.active())?.setAttributes(attributes);
}
