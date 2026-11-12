#!/usr/bin/env node
// The web build for the desktop app: the same `vite build`, with the runtimes (PDF, OCR, the JPEG XL / AVIF / JPEG 2000 /
// DjVu decoders, ONNX Runtime) copied into dist/ so nothing has to come from a CDN, which the desktop app's Content
// Security Policy forbids. Sets QN_ORT_LOCAL=1 in a way that works in every shell (cmd.exe does not understand
// `VAR=1 command`).
import { spawnSync } from 'node:child_process';

// --test: the build the end-to-end suites drive, with the window.qn hooks (QN_TEST_HOOKS=1); never one to ship.
const test = process.argv.includes('--test');
const r = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true, env: { ...process.env, QN_ORT_LOCAL: '1', ...(test ? { QN_TEST_HOOKS: '1' } : {}) } });
process.exit(r.status ?? 1);
