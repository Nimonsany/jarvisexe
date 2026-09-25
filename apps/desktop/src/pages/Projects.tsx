import { useEffect, useState } from 'react';
import { JarvisClient } from '../services/JarvisClient';
import type { ProjectInfo } from '../types';

export function Projects({ onUseAsDefault }: { onUseAsDefault?: (path: string) => void }) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const refresh = () => JarvisClient.listProjects().then(setProjects).catch(() => {});
  useEffect(() => { refresh(); }, []);
  return (
    <div className="page">
      <h1>Projects</h1>
      {projects.length === 0 && <p className="muted">No projects yet — run a task first.</p>}
      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.path}>
            <span className="mono">{p.path}</span>
            <span className="muted">{p.latestTask ? `latest: ${p.latestTask} (${p.status})` : ''}</span>
            <span className="controls">
              <button onClick={() => JarvisClient.openProject(p.path)} aria-label={`Open ${p.path}`}>Open folder</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
