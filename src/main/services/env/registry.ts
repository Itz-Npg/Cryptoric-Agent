/**
 * Registry of development tools Cryptoric Chan understands.
 *
 * Each entry declares how to probe the tool, how to interpret its version, and
 * which *trusted* installation routes exist. Nothing in this file may point at
 * an unofficial mirror: the installer layer enforces that every route resolves
 * to an official distribution or a verified package manager (see `installer.ts`).
 */

import type { ToolSpec } from '@shared/types'

const ALL: NodeJS.Platform[] | ['*'] = ['*']

export const TOOL_REGISTRY: ToolSpec[] = [
  // ---------------------------------------------------------------- JavaScript
  {
    id: 'node',
    label: 'Node.js',
    executables: ['node'],
    versionArgs: ['--version'],
    versionPattern: 'v?(\\d+\\.\\d+\\.\\d+)',
    requiredRange: '>=18',
    category: 'javascript',
    notes: 'Required by any project with a package.json.',
    installers: [
      {
        id: 'node-winget',
        label: 'winget (Node.js)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'Microsoft-signed winget package published by OpenJS Foundation (verified publisher).',
        officialUrl: 'https://nodejs.org/en/download'
      },
      {
        id: 'node-archive',
        label: 'nodejs.org official archive',
        source: 'archive',
        platforms: ['linux', 'darwin'],
        requiredTier: 'ask',
        trust: 'Direct download from nodejs.org with SHASUMS256 checksum verification.',
        officialUrl: 'https://nodejs.org/dist/'
      }
    ]
  },
  {
    id: 'npm',
    label: 'npm',
    executables: ['npm', 'npm.cmd'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'javascript',
    notes: 'Ships with Node.js.',
    installers: [
      {
        id: 'npm-winget',
        label: 'winget (npm)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package from the OpenJS Foundation.',
        officialUrl: 'https://www.npmjs.com/'
      }
    ]
  },
  {
    id: 'pnpm',
    label: 'pnpm',
    executables: ['pnpm', 'pnpm.cmd'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'javascript',
    installers: [
      {
        id: 'pnpm-npm',
        label: 'npm install -g pnpm',
        source: 'path',
        platforms: ALL,
        requiredTier: 'ask',
        trust: 'Global npm package; installs into the active npm prefix.',
        officialUrl: 'https://pnpm.io/installation'
      }
    ]
  },
  {
    id: 'yarn',
    label: 'Yarn',
    executables: ['yarn', 'yarn.cmd'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'javascript',
    installers: [
      {
        id: 'yarn-npm',
        label: 'npm install -g yarn',
        source: 'path',
        platforms: ALL,
        requiredTier: 'ask',
        trust: 'Global npm package from the Yarn maintainers.',
        officialUrl: 'https://classic.yarnpkg.com/en/docs/install'
      }
    ]
  },
  {
    id: 'bun',
    label: 'Bun',
    executables: ['bun', 'bun.exe'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'javascript',
    installers: [
      {
        id: 'bun-official',
        label: 'bun.sh official installer',
        source: 'archive',
        platforms: ALL,
        requiredTier: 'ask',
        trust: 'Official install script from bun.sh, verified against the published SHA-256 sum.',
        officialUrl: 'https://bun.sh/docs/installation'
      }
    ]
  },

  // ------------------------------------------------------------------- Python
  {
    id: 'python',
    label: 'Python',
    executables: ['python3', 'python', 'py'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    requiredRange: '>=3.9',
    category: 'python',
    notes: 'Checked as python3, then python, then the py launcher.',
    installers: [
      {
        id: 'python-winget',
        label: 'winget (Python.Python.3)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by the Python Software Foundation.',
        officialUrl: 'https://www.python.org/downloads/'
      },
      {
        id: 'python-uv',
        label: 'uv-managed Python',
        source: 'version-manager',
        platforms: ALL,
        requiredTier: 'ask',
        trust: 'Astral uv downloads a managed CPython build into a user directory; no admin rights needed.',
        officialUrl: 'https://docs.astral.sh/uv/'
      }
    ]
  },
  {
    id: 'pip',
    label: 'pip',
    executables: ['pip3', 'pip', 'pip3.exe', 'pip.exe'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'python',
    notes: 'Ships with Python.',
    installers: []
  },
  {
    id: 'uv',
    label: 'uv',
    executables: ['uv', 'uv.exe'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'python',
    notes: 'Fast Python package and environment manager.',
    installers: [
      {
        id: 'uv-official',
        label: 'uv installer (astral)',
        source: 'archive',
        platforms: ALL,
        requiredTier: 'ask',
        trust: 'Official astral.sh installer script, verified against the published SHA-256 sum.',
        officialUrl: 'https://docs.astral.sh/uv/getting-started/installation/'
      }
    ]
  },
  {
    id: 'poetry',
    label: 'Poetry',
    executables: ['poetry', 'poetry.exe'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'python',
    installers: [
      {
        id: 'poetry-pipx',
        label: 'pipx install poetry',
        source: 'path',
        platforms: ALL,
        requiredTier: 'ask',
        trust: 'Isolated global install via pipx from PyPI.',
        officialUrl: 'https://python-poetry.org/docs/#installation'
      }
    ]
  },

  // --------------------------------------------------------------------- Rust
  {
    id: 'rust',
    label: 'Rust (rustc)',
    executables: ['rustc'],
    versionArgs: ['--version'],
    versionPattern: 'rustc (\\d+\\.\\d+\\.\\d+)',
    category: 'rust',
    installers: [
      {
        id: 'rustup-rs',
        label: 'rustup (official)',
        source: 'version-manager',
        platforms: ALL,
        requiredTier: 'ask',
        trust: 'Official rustup-init from static.rust-lang.org, verified against the published SHA-256 sum. Installs per-user by default.',
        officialUrl: 'https://rustup.rs/'
      }
    ]
  },
  {
    id: 'cargo',
    label: 'Cargo',
    executables: ['cargo'],
    versionArgs: ['--version'],
    versionPattern: 'cargo (\\d+\\.\\d+\\.\\d+)',
    category: 'rust',
    notes: 'Ships with rustup.',
    installers: []
  },

  // ---------------------------------------------------------------------- JVM
  {
    id: 'java',
    label: 'Java (JDK)',
    executables: ['java'],
    versionArgs: ['-version'],
    versionPattern: '"?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?',
    category: 'jvm',
    installers: [
      {
        id: 'java-winget',
        label: 'winget (Microsoft OpenJDK)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by Microsoft (Eclipse Adoptium builds).',
        officialUrl: 'https://learn.microsoft.com/java/openjdk/download'
      }
    ]
  },
  {
    id: 'maven',
    label: 'Maven',
    executables: ['mvn', 'mvn.cmd'],
    versionArgs: ['--version'],
    versionPattern: 'Apache Maven (\\d+\\.\\d+\\.\\d+)',
    category: 'jvm',
    installers: [
      {
        id: 'maven-winget',
        label: 'winget (Apache.Maven)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by the Apache Software Foundation.',
        officialUrl: 'https://maven.apache.org/download.cgi'
      }
    ]
  },
  {
    id: 'gradle',
    label: 'Gradle',
    executables: ['gradle', 'gradle.bat'],
    versionArgs: ['--version'],
    versionPattern: 'Gradle (\\d+\\.\\d+)',
    category: 'jvm',
    installers: [
      {
        id: 'gradle-winget',
        label: 'winget (Gradle.Gradle)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by the Gradle team.',
        officialUrl: 'https://gradle.org/install/'
      }
    ]
  },

  // ------------------------------------------------------------------------ Go
  {
    id: 'go',
    label: 'Go',
    executables: ['go'],
    versionArgs: ['version'],
    versionPattern: 'go(\\d+\\.\\d+(?:\\.\\d+)?)',
    category: 'go',
    installers: [
      {
        id: 'go-winget',
        label: 'winget (GoLang.Go)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by the Go team.',
        officialUrl: 'https://go.dev/dl/'
      }
    ]
  },

  // --------------------------------------------------------------------- .NET
  {
    id: 'dotnet',
    label: '.NET SDK',
    executables: ['dotnet'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'dotnet',
    installers: [
      {
        id: 'dotnet-winget',
        label: 'winget (Microsoft.DotNet.SDK)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by Microsoft.',
        officialUrl: 'https://dotnet.microsoft.com/download'
      }
    ]
  },

  // ------------------------------------------------------------------- Native
  {
    id: 'cmake',
    label: 'CMake',
    executables: ['cmake'],
    versionArgs: ['--version'],
    versionPattern: 'cmake version (\\d+\\.\\d+\\.\\d+)',
    category: 'native',
    installers: [
      {
        id: 'cmake-winget',
        label: 'winget (Kitware.CMake)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by Kitware.',
        officialUrl: 'https://cmake.org/download/'
      }
    ]
  },
  {
    id: 'ninja',
    label: 'Ninja',
    executables: ['ninja'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'native',
    installers: [
      {
        id: 'ninja-winget',
        label: 'winget (Ninja-build.Ninja)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by the Ninja build maintainers.',
        officialUrl: 'https://ninja-build.org/'
      }
    ]
  },
  {
    id: 'msvc',
    label: 'MSVC toolchain',
    executables: ['cl'],
    versionArgs: [],
    versionPattern: '',
    category: 'native',
    notes: 'Only resolvable inside a Developer Command Prompt; detection reports the caveat rather than failing.',
    installers: []
  },

  // ---------------------------------------------------------------------- VCS
  {
    id: 'git',
    label: 'Git',
    executables: ['git'],
    versionArgs: ['--version'],
    versionPattern: 'git version (\\d+\\.\\d+(\\.\\d+)?)',
    category: 'vcs',
    installers: [
      {
        id: 'git-winget',
        label: 'winget (Git.Git)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by the Git for Windows maintainers.',
        officialUrl: 'https://git-scm.com/download/win'
      }
    ]
  },

  // ----------------------------------------------------------------- Container
  {
    id: 'docker',
    label: 'Docker',
    executables: ['docker'],
    versionArgs: ['--version'],
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
    category: 'container',
    notes: 'Reports the CLI version; engine availability is checked separately.',
    installers: [
      {
        id: 'docker-winget',
        label: 'winget (Docker.DockerDesktop)',
        source: 'winget',
        platforms: ['win32'],
        requiredTier: 'elevated',
        trust: 'winget package published by Docker Inc. Installs Docker Desktop, which requires a Windows edition with WSL2 or Hyper-V.',
        officialUrl: 'https://www.docker.com/products/docker-desktop/'
      }
    ]
  }
]

export const TOOL_BY_ID = new Map(TOOL_REGISTRY.map((t) => [t.id, t]))

export function getToolSpec(id: string): ToolSpec | null {
  return TOOL_BY_ID.get(id) ?? null
}

/** Tools grouped for the environment inspector. */
export const TOOL_CATEGORY_ORDER: ToolSpec['category'][] = [
  'javascript',
  'python',
  'rust',
  'jvm',
  'go',
  'dotnet',
  'native',
  'vcs',
  'container'
]

/**
 * Tools that should always be probed. Everything else is probed on demand or
 * because a project manifest requires it.
 */
export const CORE_TOOL_IDS = ['git', 'node', 'npm', 'pnpm', 'python', 'rust', 'java', 'go', 'docker'] as const