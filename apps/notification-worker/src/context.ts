import { PrismaClient } from '@prisma/client';
import { Resend } from 'resend';

// Single boot-time wire-up. Exposing the dependencies through a
// ``Context`` object keeps the dispatcher pure and gives the test suite
// a clean handle to mock — the dispatcher never touches ``process.env``
// or imports the Prisma / Resend SDKs directly.

export interface Context {
  prisma: PrismaClient;
  resend: Resend | null;
  from: string;
}

export async function buildContext(): Promise<Context> {
  const prisma = new PrismaClient();
  await prisma.$connect();

  const key = process.env.RESEND_API_KEY;
  const resend = key ? new Resend(key) : null;
  const from = process.env.EMAIL_FROM || 'StudyForge <onboarding@resend.dev>';
  return { prisma, resend, from };
}
