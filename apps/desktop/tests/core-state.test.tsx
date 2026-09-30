import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import App from '../src/App';
import { TaskInput } from '../src/components/Panels';

afterEach(cleanup);

describe('startup state machine (BLOCKER 1)', () => {
  test('endpoint unresolved → deterministic Error state with Retry', async () => {
    render(<App />);
    // no Tauri runtime, no VITE_JARVIS_CORE_URL → CORE_ENDPOINT_UNRESOLVED on first attempt
    const state = await screen.findByTestId('core-state', {}, { timeout: 10_000 });
    await waitFor(() => expect(state.textContent).toContain('Error'), { timeout: 10_000 });
    expect(screen.getByLabelText('Retry core connection')).toBeTruthy();
  }, 15_000);

  test('Retry resets the state machine (re-enters Starting…)', async () => {
    render(<App />);
    const state = await screen.findByTestId('core-state', {}, { timeout: 10_000 });
    expect(state.textContent).toContain('Error');
    fireEvent.click(screen.getByLabelText('Retry core connection'));
    await screen.findByText(/Starting Core/, {}, { timeout: 5_000 });
  }, 15_000);
});

describe('Execute gating on core readiness', () => {
  test('ready=false keeps Execute disabled even with text', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<TaskInput onSubmit={onSubmit} busy={false} ready={false} />);
    const input = screen.getByLabelText('What would you like me to do?');
    const exec = screen.getByRole('button', { name: 'Execute task' });
    fireEvent.change(input, { target: { value: 'Build a calculator' } });
    expect((exec as HTMLButtonElement).disabled).toBe(true);
    rerender(<TaskInput onSubmit={onSubmit} busy={false} ready />);
    expect((exec as HTMLButtonElement).disabled).toBe(false);
  });

  test('ready defaults to true (unit-level input logic unchanged)', () => {
    render(<TaskInput onSubmit={vi.fn()} busy={false} />);
    const exec = screen.getByRole('button', { name: 'Execute task' });
    fireEvent.change(screen.getByLabelText('What would you like me to do?'), { target: { value: 'x' } });
    expect((exec as HTMLButtonElement).disabled).toBe(false);
  });
});
