import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TaskInput } from '../src/components/Panels';
import { Pipeline, StatusPill, humanEvent } from '../src/components/Status';
import { HealthBar } from '../src/components/Panels';
import type { Task, TaskEvent, Health } from '../src/types';

afterEach(cleanup); // RTL auto-cleanup needs vitest globals; do it explicitly

describe('TaskInput', () => {
  test('submit disabled when empty, calls onSubmit with request', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<TaskInput onSubmit={onSubmit} busy={false} />);
    const input = screen.getByLabelText('What would you like me to do?');
    const exec = screen.getByRole('button', { name: 'Execute task' });
    expect((exec as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Build a calculator web app' } });
    expect((exec as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(exec);
    expect(onSubmit).toHaveBeenCalledWith('Build a calculator web app', undefined);
    expect((input as HTMLInputElement).value).toBe(''); // input cleared after submit
  });
});

describe('status rendering (backend-authoritative)', () => {
  const base: Task = {
    id: 'TASK-000001', owner_request: 'calc', created_at: '2026-09-25T10:00:00Z', updated_at: '',
    status: 'EXECUTING', current_phase: '', project_directory: '/tmp/p', opencode_session: null,
    retry_count: 0, chatgpt_cycle_count: 0, last_error: null, result: null, verification_status: 'UNVERIFIED',
  };
  test('StatusPill renders state label', () => {
    render(<StatusPill status="PLANNING" />);
    expect(screen.getByText(/Planning with ChatGPT/)).toBeTruthy();
  });
  test('pipeline: planning done, executing active, testing pending', () => {
    render(<Pipeline task={base} />);
    const steps = screen.getAllByRole('listitem');
    expect(steps[0].className).toContain('done');
    expect(steps[1].className).toContain('active');
    expect(steps[2].className).toContain('pending');
  });
  test('failed task marks past steps bad', () => {
    render(<Pipeline task={{ ...base, status: 'FAILED' }} />);
    expect(screen.getAllByRole('listitem')[0].className).toContain('bad');
  });
});

describe('humanEvent', () => {
  const ev = (event: string, data?: Record<string, unknown>): TaskEvent => ({
    timestamp: '', task_id: '', component: '', event, severity: 'info', data,
  });
  test('maps known events', () => {
    expect(humanEvent(ev('task_created'))).toBe('Task created');
    expect(humanEvent(ev('self_repair_attempt', { attempt: 1 }))).toBe('JARVIS self-repair attempt 1/2');
    expect(humanEvent(ev('consulting_chatgpt_for_debug', { cycle: 2 }))).toContain('cycle 2');
  });
  test('state transitions map to target label', () => {
    expect(humanEvent(ev('state_testing_to_verifying'))).toBe('Verification');
    // planning→waiting has a dedicated human description
    expect(humanEvent(ev('state_planning_to_waiting_for_chatgpt'))).toBe('Planning prompt submitted');
  });
});

describe('HealthBar / first-run', () => {
  test('shows login required + Open ChatGPT Login button', () => {
    const health: Health = { core: 'online', opencode: 'ready', chatgptProfile: 'ready', chatgptLogin: 'required', storage: 'ready' };
    const onLogin = vi.fn();
    render(<HealthBar health={health} onLogin={onLogin} />);
    expect(screen.getAllByText(/ChatGPT/i).length).toBeGreaterThan(0);
    const btn = screen.getByRole('button', { name: 'Open ChatGPT Login' });
    fireEvent.click(btn);
    expect(onLogin).toHaveBeenCalled();
  });
  test('offline health renders offline', () => {
    render(<HealthBar health={null} onLogin={() => {}} />);
    expect(screen.getByText(/offline/i)).toBeTruthy();
  });
});

describe('CurrentTaskPanel error experience', () => {
  test('shows retry state and useful error info', async () => {
    const { ErrorBanner } = await import('../src/components/Panels');
    const base: Task = {
      id: 'T1', owner_request: 'x', created_at: '', updated_at: '', status: 'DEBUGGING',
      current_phase: '', project_directory: '', opencode_session: null, retry_count: 1,
      chatgpt_cycle_count: 0, last_error: 'Error: test calc failed', result: null, verification_status: 'FAILED',
    };
    render(<ErrorBanner task={base} />);
    expect(screen.getByText(/Handling a problem/)).toBeTruthy();
    expect(screen.getByText(/self-repair/i)).toBeTruthy();
  });
});
