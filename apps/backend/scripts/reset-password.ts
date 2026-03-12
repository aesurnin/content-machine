/**
 * Reset user password.
 * Run from apps/backend: npx tsx scripts/reset-password.ts <email> <new-password>
 * Or from repo root: cd apps/backend && npx tsx scripts/reset-password.ts <email> <new-password>
 */
import path from 'path';
import { config } from 'dotenv';

config({ path: path.join(process.cwd(), '.env') });
config({ path: path.resolve(process.cwd(), '../../.env') });

import { db } from '../src/db/index.js';
import { users } from '../src/db/schema/index.js';
import { eq } from 'drizzle-orm';
import { Argon2id } from 'oslo/password';

async function main() {
  const [email, newPassword] = process.argv.slice(2);
  if (!email || !newPassword) {
    console.error('Usage: npx tsx scripts/reset-password.ts <email> <new-password>');
    process.exit(1);
  }
  if (newPassword.length < 6) {
    console.error('Password must be at least 6 characters');
    process.exit(1);
  }

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!existing) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  const hashedPassword = await new Argon2id().hash(newPassword);
  await db.update(users).set({ password_hash: hashedPassword }).where(eq(users.id, existing.id));
  console.log(`Password reset for ${email}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
