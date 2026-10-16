import { z } from 'zod';
import { RUM_PAYLOAD_VERSION } from './payload.js';

/**
 * Server-side validation for beacons sent by the RUM client (used by POST /api/rum in Phase 3).
 * Kept next to the client so both sides change together. Never bundled into the browser script.
 */
const Scalar = z.union([z.string().max(300), z.number().finite()]);

export const RumMetricSchema = z.object({
  name: z.enum(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']),
  id: z.string().min(1).max(100),
  value: z.number().finite().min(0).max(120_000),
  rating: z.enum(['good', 'needs-improvement', 'poor']),
  navigationType: z.string().max(40),
  attribution: z
    .record(z.string().max(60), z.union([Scalar, z.record(z.string().max(60), Scalar)]))
    .optional(),
});

export const RumPayloadSchema = z.object({
  v: z.literal(RUM_PAYLOAD_VERSION),
  key: z.string().min(1).max(100),
  url: z.url({ protocol: /^https?$/ }).max(300),
  device: z.enum(['mobile', 'tablet', 'desktop']),
  connection: z.string().max(20).optional(),
  metrics: z.array(RumMetricSchema).min(1).max(50),
});

export type RumPayloadInput = z.infer<typeof RumPayloadSchema>;
