import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Voice layer (Milestone 5): wake word → record → speech-to-text (whisper.cpp,
 * local) → interpreted command → JARVIS Core → execute → TTS response.
 *
 * - STT: whisper-cli with the ggml-small model (Nepali/English/mixed support), 100% local.
 * - Wake word "Jarvis": must be the FIRST word of the utterance (fuzzy match for
 *   transcription variants: jarvis/javas/jervis…) — avoids accidental activation
 *   from movies/YouTube/background speech mid-sentence.
 * - Push-to-talk: record once, no wake word needed.
 * - TTS: `say` — Devanagari text uses the hi_IN voice (Lekha) which reads the
 *   Devanagari script; other text uses the default English voice.
 * - macOS microphone permission: the OS prompts on the first recording.
 */
export class VoiceLayer {
  private modelPath: string;
  private recordDir: string;

  constructor(modelDir?: string, recordDir?: string) {
    this.modelPath = path.join(modelDir ?? path.join(os.homedir(), '.jarvis', 'models'), 'ggml-small.bin');
    this.recordDir = recordDir ?? path.join(os.homedir(), '.jarvis', 'voice-tmp');
    mkdirSync(this.recordDir, { recursive: true });
  }

  modelReady(): boolean {
    return existsSync(this.modelPath);
  }

  whisperReady(): boolean {
    try {
      execFileSync('whisper-cli', ['--version'], { stdio: 'ignore', timeout: 10000 });
      return true;
    } catch { return false; }
  }

  /** List available microphone input devices (ffmpeg avfoundation). */
  listMicDevices(): { index: number; name: string }[] {
    try {
      const out = execFileSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      // ffmpeg prints device lists on STDERR
      void out;
    } catch (e) {
      const err = e as { stderr?: string };
      const stderr = err.stderr ?? '';
      const devices: { index: number; name: string }[] = [];
      let inAudio = false;
      for (const line of stderr.split('\n')) {
        if (/AVFoundation video devices/i.test(line)) { inAudio = false; continue; }
        if (/AVFoundation audio devices/i.test(line)) { inAudio = true; continue; }
        const m = inAudio ? line.match(/\[(\d+)\]\s+(.+)/) : null;
        if (m) devices.push({ index: Number(m[1]), name: m[2].trim() });
      }
      return devices;
    }
    return [];
  }

  /** Record from the microphone via ffmpeg (16 kHz mono wav). Returns the wav path. */
  record(durationMs: number, deviceIndex?: number): string {
    const wav = path.join(this.recordDir, `rec-${Date.now()}.wav`);
    const secs = Math.max(1, Math.round(durationMs / 1000));
    const input = `:${deviceIndex ?? 0}`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'avfoundation', '-i', input, '-t', String(secs), '-ar', '16000', '-ac', '1', wav], { timeout: secs * 1000 + 15000, stdio: ['ignore', 'ignore', 'ignore'] });
    if (!existsSync(wav)) throw new Error('recording produced no file (check microphone permission)');
    return wav;
  }

  /** Speech-to-text via local whisper.cpp. Returns { text, language }. */
  transcribe(wavPath: string): { text: string; language: string } {
    if (!existsSync(wavPath)) throw new Error(`audio not found: ${wavPath}`);
    if (!existsSync(this.modelPath)) throw new Error('whisper model not downloaded');
    const out = execFileSync('whisper-cli', ['-m', this.modelPath, '-l', 'auto', '-nt', '-f', wavPath], { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = '';
    void stderr;
    // whisper-cli prints segments on stdout (-nt = no timestamps); take non-empty lines
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const text = lines.join(' ').trim();
    // language detection: whisper prints it on stderr normally; infer from script
    const language = /[\u0900-\u097F]/.test(text) ? 'ne/hi (Devanagari)' : 'en';
    return { text, language };
  }

  /** Wake word check: "Jarvis" (fuzzy) must START the utterance. Returns the
   *  remaining command, or null if no wake word. Handles transcription variants
   *  including Devanagari spaced forms ("जार भिस"). */
  detectWakeWord(text: string): string | null {
    const t = text.trim();
    const m = t.match(/^(?:jarvis|javas|jervis|jarvic|जार्भिस|जार\s*भिस|जर्भिस|जर\s*भिस)[\s,.:!?।]*([\s\S]*)$/i);
    if (!m) return null;
    const rest = (m[1] ?? '').trim();
    return rest.length > 0 ? rest : ''; // wake word alone → empty command (listen further)
  }

  /** Cleanup old temp recordings (older than 30 minutes). */
  cleanup(): void {
    if (!existsSync(this.recordDir)) return;
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const f of readdirSync(this.recordDir)) {
      const p = path.join(this.recordDir, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* gone */ }
    }
  }

  /**
   * Text-to-speech: Devanagari (Nepali/Hindi) → hi_IN voice (Lekha, reads
   * Devanagari script); otherwise the default English voice. Local only.
   */
  speak(text: string): { ok: boolean; voice: string } {
    const isDevanagari = /[\u0900-\u097F]/.test(text);
    const voice = isDevanagari ? 'Lekha' : undefined;
    try {
      const args = voice ? ['-v', voice, text] : [text];
      spawn('say', args, { stdio: 'ignore' });
      return { ok: true, voice: voice ?? 'default (English)' };
    } catch {
      return { ok: false, voice: voice ?? 'default' };
    }
  }

  /**
   * Push-to-talk: record once → transcribe → return the interpreted command.
   */
  pushToTalk(durationMs = 8000, deviceIndex?: number): { text: string; language: string; command: string | null } {
    this.cleanup();
    const wav = this.record(durationMs, deviceIndex);
    const { text, language } = this.transcribe(wav);
    const command = this.detectWakeWord(text) ?? (text.trim() || null);
    return { text, language, command };
  }

  /**
   * Wake-word listen loop (runs while `jarvis voice` is active): records short
   * chunks, watches for "Jarvis …", then records the instruction.
   * onCommand receives the interpreted command; stop() ends the loop.
   */
  private listening = false;
  startListenLoop(onCommand: (command: string, text: string) => void | Promise<void>, deviceIndex?: number, onStatus?: (msg: string) => void): void {
    if (this.listening) return;
    this.listening = true;
    const say = onStatus ?? console.log;
    say('🎤 Listening for the wake word "Jarvis"… (Ctrl+C to stop)');
    const loop = async () => {
      while (this.listening) {
        try {
          this.cleanup();
          const wav = this.record(4000, deviceIndex);
          const { text } = this.transcribe(wav);
          if (!text) continue;
          const command = this.detectWakeWord(text);
          if (command === null) continue; // no wake word — background speech ignored
          let finalCommand = command;
          if (command === '') {
            // wake word alone → record the instruction that follows
            say('🎤 Yes? Listening…');
            const wav2 = this.record(10000, deviceIndex);
            const t2 = this.transcribe(wav2);
            finalCommand = t2.text.trim();
          }
          if (!finalCommand) continue;
          say(`🗣 Command: "${finalCommand}"`);
          onCommand(finalCommand, finalCommand);
        } catch (e) {
          // mic permission missing etc. — report and pause before retrying
          say(`⚠ voice: ${String(e instanceof Error ? e.message : e).slice(0, 100)}`);
          await new Promise((r) => setTimeout(r, 10000));
        }
      }
    };
    void loop();
  }

  stopListenLoop(): void {
    this.listening = false;
  }
}
