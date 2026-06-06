# SV Market Simulator

AI-powered startup market research simulator. Tests ideas against NVIDIA Nemotron-Personas-El-Salvador synthetic dataset using Claude.

**Warning:** Synthetic personas simulate behavior — they are not proof of real market demand.

## Setup

```bash
cd ~/Desktop/sv-market-simulator
npm install
```

Add your Anthropic API key to `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3001
```

## Run

```bash
npm start
```

Open: **http://localhost:3001**

## Load Dataset

**Quick load (5 000 personas, ~30 sec):**
Click **Load Dataset** in the UI — uses progressive mode, 100 rows/batch.

**Larger load via API:**
```bash
curl -X POST http://localhost:3001/api/dataset/load \
  -H "Content-Type: application/json" \
  -d '{"mode":"progressive","batchSize":100,"maxRows":20000}'
```

**Full dataset (~148k, very long):**
```bash
curl -X POST http://localhost:3001/api/dataset/load \
  -H "Content-Type: application/json" \
  -d '{"mode":"full","batchSize":100,"maxRows":148000}'
```

Interrupted loads resume from last offset. Partial caches are preserved.

## Check Status

```bash
curl http://localhost:3001/api/dataset/status
```
