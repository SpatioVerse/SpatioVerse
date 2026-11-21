import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export const maxDuration = 30;

const PRIMARY_LIVE_MODEL =
  process.env.VOICE_LIVE_MODEL?.trim() || 'gemini-3.1-flash-live-preview';
const FALLBACK_LIVE_MODEL =
  process.env.VOICE_LIVE_FALLBACK_MODEL?.trim() ||
  'gemini-2.5-flash-native-audio-latest';

export async function POST(request: Request): Promise<NextResponse> {
  const requestId =
    request.headers.get('x-request-id')?.trim() || crypto.randomUUID();
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    return NextResponse.json(
      {
        error: {
          code: 'MISSING_API_KEY',
          message:
            'GEMINI_API_KEY is not configured on the server. Add it to .env.local to enable live voice editing.',
          requestId,
        },
      },
      { status: 503, headers: { 'x-request-id': requestId } }
    );
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: 'v1alpha' },
    });

    const expireTime = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const newSessionExpireTime = new Date(
      Date.now() + 2 * 60 * 1000
    ).toISOString();

    const token = await ai.authTokens.create({
      config: {
        uses: 2, // allows seamless fallback model reconnect within the same session start
        expireTime,
        newSessionExpireTime,
      },
    });

    if (!token?.name) {
      return NextResponse.json(
        {
          error: {
            code: 'TOKEN_CREATION_FAILED',
            message: 'Gemini did not return an ephemeral session token.',
            requestId,
          },
        },
        { status: 502, headers: { 'x-request-id': requestId } }
      );
    }

    return NextResponse.json(
      {
        token: token.name,
        model: PRIMARY_LIVE_MODEL,
        fallbackModel: FALLBACK_LIVE_MODEL,
        expiresAt: expireTime,
        requestId,
      },
      {
        status: 200,
        headers: {
          'x-request-id': requestId,
          'cache-control': 'no-store',
        },
      }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to create Gemini Live token.';
    return NextResponse.json(
      {
        error: {
          code: 'LIVE_TOKEN_ERROR',
          message,
          requestId,
        },
      },
      { status: 502, headers: { 'x-request-id': requestId } }
    );
  }
}
