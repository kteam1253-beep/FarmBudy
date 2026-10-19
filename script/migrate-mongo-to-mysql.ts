import { MongoClient, ObjectId } from "mongodb";
import mysql from "mysql2/promise";
import { randomUUID } from "crypto";

const mongoUrl = process.env.MONGO_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!mongoUrl) {
  throw new Error("MONGO_URL is required for migration.");
}

if (!databaseUrl?.startsWith("mysql")) {
  throw new Error("DATABASE_URL must be a MySQL connection string for migration.");
}

function normalize(value: any): any {
  if (value instanceof ObjectId) return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) out[key] = normalize(child);
    return out;
  }
  return value;
}

async function main() {
  const mongo = new MongoClient(mongoUrl);
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 5 });

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS app_documents (
      collection_name VARCHAR(128) NOT NULL,
      doc_id VARCHAR(191) NOT NULL,
      data_json JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (collection_name, doc_id),
      KEY idx_collection_updated (collection_name, updated_at)
    )
  `);

  await mongo.connect();
  const db = mongo.db();
  const collections = await db.listCollections().toArray();
  let total = 0;

  for (const collection of collections) {
    const name = collection.name;
    const docs = await db.collection(name).find({}).toArray();
    let count = 0;

    for (const raw of docs) {
      const doc = normalize(raw);
      const id = String(doc._id || randomUUID());
      doc._id = id;
      await pool.execute(
        "INSERT INTO app_documents (collection_name, doc_id, data_json, created_at, updated_at) VALUES (?, ?, CAST(? AS JSON), NOW(), NOW()) ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), updated_at = NOW()",
        [name, id, JSON.stringify(doc)]
      );
      count += 1;
    }

    total += count;
    console.log(`${name}: migrated ${count} document(s)`);
  }

  await mongo.close();
  await pool.end();
  console.log(`Done. Migrated ${total} document(s) from ${collections.length} collection(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
