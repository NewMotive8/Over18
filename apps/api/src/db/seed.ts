import { createDb } from './client.js';
import { characters } from './schema.js';
import { SEED_CHARACTERS } from './seed-data.js';

/**
 * Idempotent character seeding: upserts the deterministic seed characters by
 * their fixed UUIDs. Safe to run repeatedly (locally, in CI, or on Railway) —
 * reruns update the seeded rows and never create duplicates or touch other rows.
 *
 * Usage: npm run db:seed -w apps/api   (reads DATABASE_URL)
 */
export async function seedCharacters(db: ReturnType<typeof createDb>['db']): Promise<number> {
  for (const seed of SEED_CHARACTERS) {
    await db
      .insert(characters)
      .values(seed)
      .onConflictDoUpdate({
        target: characters.id,
        set: {
          name: seed.name,
          displayName: seed.displayName,
          profileImage: seed.profileImage,
          shortBio: seed.shortBio,
          personality: seed.personality,
          interests: seed.interests,
          conversationStyle: seed.conversationStyle,
          systemPrompt: seed.systemPrompt,
          status: seed.status,
          updatedAt: new Date(),
        },
      });
  }
  return SEED_CHARACTERS.length;
}

// Run directly: node dist/db/seed.js (or via the db:seed npm script)
if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('FATAL: DATABASE_URL is not set — cannot seed.');
    process.exit(1);
  }
  const { db, pool } = createDb(databaseUrl);
  const count = await seedCharacters(db);
  console.log(`Seeded ${count} characters.`);
  await pool.end();
}
