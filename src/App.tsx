import { useState } from "react";
import type { Project, Task } from "./types";
import { mockProjects } from "./mockData";
import "./App.css";

// Phase 1 UI shell for Dogger.
//
// Layout: a fixed sidebar listing projects + a main area that shows the
// selected project's configuration and tasks. There is NO real Docker
// execution yet — "Run" buttons are placeholders.
//
// TODO(next): wire the sidebar to projects loaded from disk via Tauri commands.
// TODO(next): implement task execution by running `docker exec` on main.sh.

function App() {
  const [projects] = useState<Project[]>(mockProjects);
  const [selectedId, setSelectedId] = useState<string | null>(
    mockProjects[0]?.id ?? null,
  );

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <h1 className="brand-name">Dogger</h1>
        </div>

        <div className="sidebar-section-label">
          <span>Projects</span>
          {/* TODO(next): open a "new project" dialog. */}
          <button className="icon-button" title="Add project (coming soon)" disabled>
            +
          </button>
        </div>

        <nav className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              className={
                "project-item" + (project.id === selectedId ? " is-active" : "")
              }
              onClick={() => setSelectedId(project.id)}
            >
              <span className="project-item-name">{project.name}</span>
              <span className="project-item-meta">
                {project.tasks.length} task
                {project.tasks.length === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">Phase 1 · UI shell</div>
      </aside>

      <main className="main">
        {selected ? (
          <ProjectView project={selected} />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}

function ProjectView({ project }: { project: Project }) {
  return (
    <div className="project-view">
      <header className="project-header">
        <h2>{project.name}</h2>
        <dl className="project-config">
          <div>
            <dt>Project directory</dt>
            <dd>
              <code>{project.projectDir}</code>
            </dd>
          </div>
          <div>
            <dt>Container working dir</dt>
            <dd>
              <code>{project.containerWorkingDir}</code>
            </dd>
          </div>
          <div>
            <dt>Containers</dt>
            <dd>
              {project.containers.length === 0
                ? "—"
                : project.containers.map((c) => (
                    <span key={c.id} className="chip" title={c.reference}>
                      {c.name}
                    </span>
                  ))}
            </dd>
          </div>
        </dl>
      </header>

      <section className="tasks">
        <div className="section-head">
          <h3>Tasks</h3>
          {/* TODO(next): create a task = scaffold a directory with main.sh. */}
          <button className="ghost-button" disabled>
            New task
          </button>
        </div>

        {project.tasks.length === 0 ? (
          <p className="muted">No tasks yet.</p>
        ) : (
          <ul className="task-list">
            {project.tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <li className="task-row">
      <div className="task-info">
        <span className="task-name">{task.name}</span>
        <code className="task-entry">{task.dir}/main.sh</code>
        {task.description && (
          <span className="task-desc">{task.description}</span>
        )}
      </div>
      {/* TODO(next): run main.sh inside the selected container via docker exec. */}
      <button className="run-button" disabled title="Execution coming in a later phase">
        ▶ Run
      </button>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <p>Select a project to get started.</p>
    </div>
  );
}

export default App;
