import type { Project } from "./types";

// Placeholder data so the Phase 1 UI shell is browsable without any backend.
// TODO(phase-1): replace with projects loaded from disk via a Tauri command.
export const mockProjects: Project[] = [
  {
    id: "acme-api",
    name: "Acme API",
    projectDir: "~/Dogger/acme-api",
    containerWorkingDir: "/var/www/html",
    containers: [
      { id: "php", name: "PHP / FPM", reference: "acme-api-php" },
      { id: "db", name: "Postgres", reference: "acme-api-db" },
    ],
    tasks: [
      {
        id: "migrate",
        name: "Run migrations",
        dir: "migrate",
        description: "Applies pending database migrations.",
      },
      {
        id: "seed",
        name: "Seed demo data",
        dir: "seed",
        description: "Loads demo fixtures for local testing.",
      },
    ],
  },
  {
    id: "marketing-site",
    name: "Marketing Site",
    projectDir: "~/Dogger/marketing-site",
    containerWorkingDir: "/app",
    containers: [{ id: "node", name: "Node 20", reference: "marketing-node" }],
    tasks: [
      {
        id: "build",
        name: "Build static site",
        dir: "build",
        description: "Compiles the static marketing site.",
      },
    ],
  },
];
