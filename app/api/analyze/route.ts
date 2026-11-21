import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { FT_TO_METERS } from '@/lib/schema';
import {
  ANALYZE_MODEL_ID,
  analyzeSpaceMedia,
  analyzeSpaceUrl,
  GeminiServiceError,
  type AnalyzeRoomHint,
} from '@/lib/gemini';

export const maxDuration = 60;

const JsonAnalyzeRequestSchema = z
  .object({
    mediaUrl: z.string().default(''),
    youtubeId: z.string().nullable().optional(),
    sourceType: z.string().optional(),
    style: z.string().optional(),
    notes: z.string().optional(),
    room: z
      .object({
        width: z.number().positive(),
        depth: z.number().positive(),
        height: z.number().positive(),
        entranceWall: z.enum(['north', 'south', 'east', 'west']).optional(),
      })
      .optional(),
  })
  .passthrough();

function parseMultipartRoomHint(formData: FormData): AnalyzeRoomHint | undefined {
  const widthFt = Number(formData.get('widthFt'));
  const depthFt = Number(formData.get('depthFt'));
  const heightFt = Number(formData.get('heightFt'));
  if (
    !Number.isFinite(widthFt) ||
    widthFt <= 0 ||
    !Number.isFinite(depthFt) ||
    depthFt <= 0
  ) {
    return undefined;
  }
  const safeHeightFt =
    Number.isFinite(heightFt) && heightFt > 0 ? heightFt : 9;
  const rawWall = String(formData.get('entranceWall') ?? '').toLowerCase();
  const entranceWall =
    rawWall === 'north' ||
    rawWall === 'south' ||
    rawWall === 'east' ||
    rawWall === 'west'
      ? rawWall
      : 'south';

  return {
    width: Number((widthFt * FT_TO_METERS).toFixed(4)),
    depth: Number((depthFt * FT_TO_METERS).toFixed(4)),
    height: Number((safeHeightFt * FT_TO_METERS).toFixed(4)),
    entranceWall,
  };
}

function extractUploadedFile(formData: FormData): File | null {
  const preferredKeys = ['file', 'media', 'video', 'image'];
  for (const key of preferredKeys) {
    const entry = formData.get(key);
    if (entry instanceof File) {
      return entry;
    }
  }
  for (const [, entry] of formData.entries()) {
    if (entry instanceof File) {
      return entry;
    }
  }
  return null;
}

function buildMultipartNotes(formData: FormData): string | undefined {
  const parts: string[] = [];
  const notes = formData.get('notes');
  if (typeof notes === 'string' && notes.trim()) {
    parts.push(notes.trim());
  }
  const style = formData.get('style');
  if (typeof style === 'string' && style.trim()) {
    parts.push(`Desired style: ${style.trim()}`);
  }
  const entranceWall = formData.get('entranceWall');
  if (typeof entranceWall === 'string' && entranceWall.trim()) {
    parts.push(`User-indicated entrance wall: ${entranceWall.trim()}`);
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId =
    request.headers.get('x-request-id')?.trim() || crypto.randomUUID();
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();

  try {
    // Format 1: JSON body (YouTube or direct video URL from MediaIntakeModal)
    if (contentType.includes('application/json')) {
      let rawJson: unknown;
      try {
        rawJson = await request.json();
      } catch {
        return NextResponse.json(
          {
            error: {
              code: 'INVALID_JSON',
              message: 'Request body must be valid JSON.',
              requestId,
              modelAttempted: ANALYZE_MODEL_ID,
            },
          },
          { status: 400, headers: { 'x-request-id': requestId } }
        );
      }

      const parsed = JsonAnalyzeRequestSchema.safeParse(rawJson);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: {
              code: 'INVALID_INPUT',
              message: 'Invalid JSON payload for /api/analyze.',
              requestId,
              modelAttempted: ANALYZE_MODEL_ID,
            },
          },
          { status: 400, headers: { 'x-request-id': requestId } }
        );
      }

      const combinedNotes = [
        parsed.data.notes?.trim(),
        parsed.data.style?.trim()
          ? `Desired style: ${parsed.data.style.trim()}`
          : undefined,
      ]
        .filter(Boolean)
        .join(' | ');

      const result = await analyzeSpaceUrl({
        mediaUrl: parsed.data.mediaUrl,
        youtubeId: parsed.data.youtubeId,
        notes: combinedNotes || undefined,
        roomHint: parsed.data.room,
        requestId,
      });

      return NextResponse.json(
        {
          observations: result.observations,
          roomCues: result.roomCues,
          warnings: result.warnings,
          modelUsed: result.modelUsed,
          requestId: result.requestId,
          uploadMethod: result.uploadMethod,
        },
        { status: 200, headers: { 'x-request-id': requestId } }
      );
    }

    // Format 2: multipart/form-data file/camera upload (MediaIntakeModal & SetupWizard)
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_CONTENT_TYPE',
            message:
              'Expected multipart/form-data upload or application/json video link payload.',
            requestId,
            modelAttempted: ANALYZE_MODEL_ID,
          },
        },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        {
          error: {
            code: 'FAILED_UPLOAD_PARSE',
            message: 'Could not parse multipart/form-data upload payload.',
            requestId,
            modelAttempted: ANALYZE_MODEL_ID,
          },
        },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    const uploadedFile = extractUploadedFile(formData);
    if (!uploadedFile) {
      return NextResponse.json(
        {
          error: {
            code: 'MISSING_FILE',
            message:
              'No media file found in form-data. Provide a file under field "file" (or "media").',
            requestId,
            modelAttempted: ANALYZE_MODEL_ID,
          },
        },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    const notes = buildMultipartNotes(formData);
    const roomHint = parseMultipartRoomHint(formData);
    const arrayBuffer = await uploadedFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await analyzeSpaceMedia({
      buffer,
      mimeType: uploadedFile.type,
      fileName: uploadedFile.name,
      notes,
      roomHint,
      requestId,
    });

    return NextResponse.json(
      {
        observations: result.observations,
        roomCues: result.roomCues,
        warnings: result.warnings,
        modelUsed: result.modelUsed,
        requestId: result.requestId,
        uploadMethod: result.uploadMethod,
      },
      {
        status: 200,
        headers: { 'x-request-id': requestId },
      }
    );
  } catch (err) {
    if (err instanceof GeminiServiceError) {
      return NextResponse.json(
        {
          error: {
            code: err.code,
            message: err.message,
            requestId: err.requestId,
            modelAttempted: err.modelAttempted ?? ANALYZE_MODEL_ID,
          },
        },
        {
          status: err.status,
          headers: { 'x-request-id': requestId },
        }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unexpected server error while analyzing space media.',
          requestId,
          modelAttempted: ANALYZE_MODEL_ID,
        },
      },
      {
        status: 500,
        headers: { 'x-request-id': requestId },
      }
    );
  }
}
