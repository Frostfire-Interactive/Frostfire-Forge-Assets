<p align="center">
  <img src="../../blob/main/logo.png?raw=true">
</p>

<h1 align="center">🧊🔥 Frostfire Forge Assets 🔥🧊</h1>

<p align="center">
  <strong>Centralized Asset Server for Frostfire Forge MMO Engine</strong>
</p>

<p align="center">
Frostfire Forge Assets is a dedicated server for managing and distributing game assets in the Frostfire Forge MMO platform. It provides a centralized repository for maps, sprites, animations, and game resources with real-time update capabilities for collaborative world building.
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/Frostfire-Interactive/Frostfire-Forge-Assets/release.yml?branch=main&label=Docker&style=flat-square" alt="Docker">
  <img src="https://img.shields.io/badge/status-Beta-blue?style=flat-square&label=Status" alt="Beta">
  <img src="https://img.shields.io/github/stars/Frostfire-Interactive/Frostfire-Forge?style=flat-square&label=Stars&color=tomato" alt="GitHub Stars">
</p>

---

> [!NOTE]
> **Project Status**: This project is currently a **work in progress**
>
> **Core Development Team**: [Lillious](https://github.com/Lillious), [Deph0](https://github.com/Deph0)
>
> **Community**: [Join our Discord](https://discord.gg/4spUbuXBvZ)

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Requirements](#-requirements)
- [Architecture](#-architecture)
  - [Asset Management](#asset-management)
  - [Map Data Persistence](#map-data-persistence)
- [Quick Start](#-quick-start)
  - [Development Setup](#development-setup)
  - [Production Setup](#production-setup)
  - [Docker Deployment](#docker-deployment)
- [Environment Variables](#-environment-variables)
- [API Documentation](#-api-documentation)
  - [Map Endpoints](#map-endpoints)
  - [Sprite Endpoints](#sprite-endpoints)
  - [Asset Endpoints](#asset-endpoints)
  - [Authentication](#authentication)

---

## 📖 Overview

The Frostfire Forge Asset Server is a required component of the Frostfire Forge MMO platform. It serves as the centralized distribution point for all game assets and data, including:

- **Map Data** - Complete tile maps with collision layers, spawn points, and environmental data
- **Sprites & Animations** - Character sprites, item graphics, NPC sprites, and animation frames
- **Game Resources** - Particle effects, NPC definitions, quest data, items, spells, and mounts
- **Real-time Updates** - Support for collaborative world building with persistent storage of tile editor changes

The asset server is designed to work in conjunction with the [Frostfire Forge Gateway](https://github.com/Frostfire-Interactive/Frostfire-Forge-Gateway) and [Frostfire Forge Game Engine](https://github.com/Frostfire-Interactive/Frostfire-Forge).

---

## 🔧 Requirements

> [!IMPORTANT]
> **Required Software**:
> - [Bun](https://bun.sh/) - JavaScript runtime & package manager
> - [Frostfire Forge Game Engine](https://github.com/Frostfire-Interactive/Frostfire-Forge) - Game server that requests assets
> - [Docker](https://www.docker.com/) (Optional) - For containerized deployment

---

## 🏗️ Architecture

### Asset Management

The asset server maintains an in-memory cache of all game assets loaded from disk. Assets are organized hierarchically:

- **Maps** - Tile-based map data with multiple layers (terrain, collision, decorative)
- **Sprites & Animations** - Sprite sheets and frame definitions for animated objects
- **Game Data** - NPCs, quests, items, spells, particles, and mounts

Assets are loaded on server startup and can be reloaded dynamically without restarting the service.

### Map Data Persistence

Maps are stored as JSON files and can be edited through the game's tile editor. When changes are made:

1. The game engine sends updated chunk data to the asset server
2. The asset server updates the in-memory cache
3. Changes are persisted to disk immediately
4. The game engine's collision cache is refreshed for immediate gameplay updates

This enables collaborative world building with instant persistence and real-time synchronization across game servers.

### World Maps

A map too large to keep as one JSON file (up to 10240 x 10240 tiles) is a `.world` directory in the maps folder: a `manifest.json`, the collision and no-PvP data, and the tiles in packs of chunks. It is known by its directory's name, so `overworld.world` is served as the map `overworld`, and it cannot share a name with a `.json` map in the same folder.

- `/map-chunk` answers for a world exactly as it does for a JSON map, reading only the packs asked for
- The game server asks `/world-list` and `/world-file` for a world's manifest and its collision and no-PvP data: the tiles stay here
- Tile editor saves (`/save-map-chunks`, `/save-map-properties`) rewrite only the packs touched, and a save cut short is repaired when the server next starts
- `/worldmap?name=` serves a world's map image baked at a reduced scale, and `/worldmap?name=&rx=&ry=` a full-detail piece of it, 1024 tiles a side

---

## ⚙️ Environment Variables

```bash
# Asset Loading
ASSETS_PATH=src/assets                    # Path to assets directory (absolute or relative)
                                          # Default: src/assets/
                                          # If directory not found, server exits with error

# Server Configuration
WEBSRV_PORT=8000                         # Web server port
WEBSRV_PORTSSL=8082                      # HTTPS port
HTTP_USE_SSL=false                       # Enable SSL/TLS

# TLS Certificates (required when HTTP_USE_SSL=true)
TLS_CERT_PATH=./src/certs/cert.pem
TLS_KEY_PATH=./src/certs/key.pem
TLS_CA_PATH=./src/certs/cert.ca-bundle

# Authentication
ASSET_SERVER_AUTH_KEY="your_secret_key"   # Shared secret for request authentication
```

### ASSETS_PATH Configuration

The `ASSETS_PATH` environment variable allows you to load assets from an external directory instead of the default `src/assets/`:

- **Absolute Path**: `ASSETS_PATH=/path/to/external/assets`
- **Relative Path**: `ASSETS_PATH=../external-assets`
- **Default**: If not set, the server uses `src/assets/`
- **Error Handling**: If the specified directory is not found, the server logs an error and exits with code 1

**Example:**
```bash
# Using external assets from a shared location
ASSETS_PATH=/mnt/shared/game-assets

# Or relative to current working directory
ASSETS_PATH=../assets
```

The asset directory must contain the following subdirectories:
- `tilesets/` - Map tileset images (PNG)
- `maps/` - Map data files (JSON)
- `animations/` - Animation templates (JSON)
- `spritesheets/` - Sprite sheet images (PNG)
- `sprites/` - Sprite effect images (PNG)
- `icons/` - Item/equipment icons (PNG)

---

## 🚀 Quick Start

### Development Setup

**Option 1: Use prebuilt Docker image:**
```bash
docker run -d --name frostfire-assets-dev -p 8000:8000 ghcr.io/Frostfire-Interactive/frostfire-forge-assets-dev:latest
```

**Option 2: Build and run from source:**
```bash
bun development
```

**Optional: Update `.env.development` before running**

The asset server will load all assets from the `src/assets/` directory on startup.

---

### Production Setup

**Update the `.env.production` file**

Configure your production environment variables including SSL certificates if needed.

**Start the production server:**
```bash
bun production
```

---

## 🐳 Docker Deployment

### Asset Path Configuration for Docker

The `ASSETS_PATH` in your `.env.development` or `.env.production` file controls where assets are loaded:

**For Docker**:
- Use relative paths with `../../` prefix (e.g., `../../src/assets`)
- Paths are resolved relative to the docker-compose file location (`src/docker/`)
- Or use absolute paths (e.g., `C:/path/to/assets`)

**For direct/local use** (running `bun development` or `bun production`):
- Use relative paths (e.g., `./src/assets`)
- Or use absolute paths to external directories (e.g., `C:/path/to/external/assets`)
- Paths are resolved relative to the project root

Inside the container, the assets are mounted at `/app/assets`, and the `ASSETS_PATH` environment variable is automatically overridden to `/app/assets` so the application uses the mounted directory.

**Example configurations:**
- Docker: `ASSETS_PATH=../../src/assets`
- Local: `ASSETS_PATH=./src/assets` or `ASSETS_PATH=C:/path/to/assets`

### Development Compose

```bash
# Start with docker-compose
bun run docker:dev

# View logs
bun run docker:dev:logs

# Stop
bun run docker:dev:down
```

### Production Compose

```bash
# Start with docker-compose
bun run docker:prod

# View logs
bun run docker:prod:logs

# Stop
bun run docker:prod:down
```

### Docker Commands

```bash
# Development
bun run docker:dev              # Start dev container
bun run docker:dev:logs         # View logs
bun run docker:dev:rebuild      # Rebuild and restart
bun run docker:dev:down         # Stop dev container

# Production
bun run docker:prod             # Start prod container
bun run docker:prod:logs        # View logs
bun run docker:prod:rebuild     # Rebuild and restart
bun run docker:prod:down        # Stop prod container
```

---

### Authentication

Write endpoints (`/update-map`, `/save-map-chunks`, `/save-map-properties`, `/map-checksums`) and the game server's world sync (`/world-list`, `/world-file`) require the `authKey` field in the request body to match the `ASSET_SERVER_AUTH_KEY` environment variable. Read endpoints are open.

**Example:**
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"authKey": "your_secret_key", "checksums": {}, "serverId": "server-1"}' \
  http://localhost:8000/map-checksums
```

If authentication fails, the server responds with a `401 Unauthorized` status.

---

## 🔄 Integration with Game Engine

The asset server is designed to work seamlessly with the Frostfire Forge Game Engine:

1. **Startup** - Game engine requests all assets from the asset server on initialization
2. **Map Loading** - Map data is fetched and cached in-memory with collision layers compressed
3. **Live Updates** - Tile editor changes are sent to the asset server and immediately reflected in-game
4. **Persistent Storage** - All asset changes are saved to disk for recovery and sharing

For game engine integration details, see the [Frostfire Forge documentation](https://github.com/Frostfire-Interactive/Frostfire-Forge).

## License

Free for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Every commercial use needs a paid [commercial license](COMMERCIAL-LICENSE.md) from Frostfire Interactive. See [LICENSING.md](LICENSING.md) for which one applies to you.

Contributions are welcome and need a signed [Contributor License Agreement](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md).

---

<p align="center">
  <sub>Built with ❤️ by the Frostfire Forge Team</sub>
</p>
