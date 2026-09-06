# HyperDev IDE

HyperDev IDE is a browser-based multi-language development environment powered by Monaco Editor and Cloudflare Sandbox.

## Goals
- VS Code-like editing experience with Monaco Editor
- Multi-language execution through a runner registry
- Python fast-path in the browser with Pyodide when possible
- Cloudflare Sandbox fallback for system-level Python features
- Cloudflare Sandbox execution for compiled/server-side languages
- Local project files, tabs, downloads, and output console

## Initial language targets
- Python
- JavaScript / Node.js
- Java
- C
- C++
- Go
- Rust

## Runtime architecture

```text
Monaco Editor
   ↓
File extension / language detection
   ↓
Runner registry
   ├─ Python → Pyodide first → Sandbox fallback
   ├─ JavaScript → Node.js in Sandbox
   ├─ Java → javac + java in Sandbox
   ├─ C → gcc in Sandbox
   ├─ C++ → g++ in Sandbox
   ├─ Go → go run in Sandbox
   └─ Rust → rustc in Sandbox
```

## Deployment
Designed for Cloudflare Workers + Cloudflare Sandbox.

The project will evolve from the existing WebPY IDE prototype into a general-purpose web IDE.
