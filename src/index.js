import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 4002;

/** Prefer MONGODB_URI for local dev; on Cloud Run support separated vars from sidecar-style setups. */
function mongoConfig() {
  const mongoUri = process.env.MONGODB_URI?.trim();
  if (mongoUri) return mongoUri;

  const username = process.env.MONGO_USER?.trim() || process.env.MONGODB_USER?.trim();
  const password = process.env.MONGO_PASSWORD ?? process.env.MONGODB_PASSWORD;
  const database = process.env.MONGO_DB?.trim() || process.env.MONGODB_DB?.trim();
  const authSource = process.env.MONGO_AUTH_SOURCE?.trim() || "admin";
  const host = process.env.MONGO_HOST?.trim() || process.env.MONGODB_HOST?.trim() || "127.0.0.1";
  const portMongo = process.env.MONGO_PORT?.trim() || process.env.MONGODB_PORT?.trim() || "27017";

  if (!database) {
    console.error(
      "Set MONGODB_URI, or provide MONGO_DB/MONGODB_DB (optional user/password/host/port) for MongoDB."
    );
    process.exit(1);
  }

  const auth =
    username && password !== undefined && password !== null
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : "";
  return `mongodb://${auth}${host}:${portMongo}/${database}?authSource=${encodeURIComponent(authSource)}`;
}

mongoose
  .connect(mongoConfig())
  .then(() => console.log("Connected to projects MongoDB"))
  .catch((err) => console.error("Mongo connection error", err));

const projectSchema = new mongoose.Schema(
  {
    name: String,
    description: String,
    url: String,
    githubId: { type: Number, unique: true, sparse: true },
  },
  { timestamps: true }
);

const Project = mongoose.model("Project", projectSchema);

async function syncFromGitHub() {
  const username = process.env.GITHUB_USERNAME;
  if (!username) return;

  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept: "application/vnd.github.v3+json",
    ...(token && { Authorization: `Bearer ${token}` }),
  };

  let repos = [];
  let page = 1;
  const perPage = 100;

  try {
    while (true) {
      const res = await fetch(
        `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=${perPage}&page=${page}&sort=updated`,
        { headers }
      );
      if (!res.ok) {
        console.warn("GitHub sync failed:", res.status, await res.text());
        return;
      }
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;
      repos = repos.concat(data);
      if (data.length < perPage) break;
      page += 1;
    }

    for (const repo of repos) {
      await Project.findOneAndUpdate(
        { githubId: repo.id },
        {
          name: repo.name,
          description: repo.description || null,
          url: repo.html_url || null,
          githubId: repo.id,
        },
        { upsert: true, new: true }
      );
    }
    console.log(`GitHub sync done: ${repos.length} repos for ${username}`);
  } catch (err) {
    console.warn("GitHub sync error:", err.message);
  }
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "projects-service" });
});

app.get("/projects", async (req, res) => {
  const limitParam = req.query.limit;
  const limit =
    typeof limitParam === "string" ? Math.max(1, Math.min(50, Number(limitParam))) : undefined;
  const query = Project.find().sort({ updatedAt: -1 }).lean();
  const projects = limit ? await query.limit(limit) : await query;
  res.json(projects);
});

app.listen(port, "0.0.0.0", async () => {
  console.log(`projects-service listening on port ${port}`);
  const mongoReady = mongoose.connection.readyState === 1;
  if (mongoReady) await syncFromGitHub();
  else mongoose.connection.once("connected", syncFromGitHub);
});

