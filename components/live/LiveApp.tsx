"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { FAMILY_LABELS } from "@/corpus/taxonomy";
import { loadCorpusBundle, type CorpusBundle } from "@/lib/corpus/client-data";
import { DETECTION } from "@/lib/detection/config";
import { RealtimeSession } from "@/lib/detection/drivers";
import type { EngineSnapshot } from "@/lib/detection/engine";
import { buildEvidencePack, clock, type EvidenceIncident } from "@/lib/evidence/pack";
import { fetchMossCredentials, RetrievalWorker } from "@/lib/moss/client";
import { detectStt, installOnDeviceStt, startStt, type SttCapability, type SttHandle } from "@/lib/stt/speech";
import { SiteNav } from "../SiteNav";
import { Chip, Panel } from "../ui";
import { ClaimList } from "./ClaimList";
import { CounterLineCard } from "./CounterLineCard";
import { EvidencePanel } from "./EvidencePanel";
import { LatencyHeader } from "./LatencyHeader";
import { MatchPanel } from "./MatchPanel";
import { PressureChart } from "./PressureChart";
import { StageTrack } from "./StageTrack";
import { TranscriptView } from "./TranscriptView";
import { VoiceCirclePanel } from "./VoiceCirclePanel";

type Boot =
  | { state: "loading"; step: string }
  | { state: "ready"; bundle: CorpusBundle; worker: RetrievalWorker }
  | { state: "error"; message: string };

type Source = { mode: "fixture"; fixtureId: string } | { mode: "mic" };

const button = "rounded-md border border-line bg-panel-2 px-3 py-1.5 text-[13px] text-fg hover:border-accent disabled:cursor-not-allowed disabled:opacity-40";

export function LiveApp() {
  const [boot, setBoot] = useState<Boot>({ state: "loading", step: "Loading corpus" });
  const [stt, setStt] = useState<SttCapability | null>(null);
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [now, setNow] = useState(0);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fixtureId, setFixtureId] = useState("");
  const [transcriptVersion, bumpTranscript] = useReducer((x: number) => x + 1, 0);
  const sttHandle = useRef<SttHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    let worker: RetrievalWorker | null = null;
    (async () => {
      try {
        const bundle = await loadCorpusBundle();
        if (cancelled) return;
        setFixtureId(bundle.corpus.fixtures[0]?.id ?? "");
        setBoot({ state: "loading", step: "Starting on-device retrieval (Moss WASM index + ONNX embedder)" });
        // ?threads=N sets ONNX Runtime threads (diagnostics); default lets ORT decide.
        const threads = Number(new URLSearchParams(window.location.search).get("threads")) || undefined;
        worker = await RetrievalWorker.start(bundle, await fetchMossCredentials(), { ortThreads: threads });
        if (cancelled) return worker.terminate();
        setBoot({ state: "ready", bundle, worker });
      } catch (err) {
        if (!cancelled) setBoot({ state: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    detectStt()
      .then((c) => !cancelled && setStt(c))
      .catch(() => !cancelled && setStt({ mode: "unavailable", installable: false, detail: "Speech recognition check failed." }));
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    setSnapshot(session.engine.snapshot);
    const offEngine = session.engine.subscribe(setSnapshot);
    const offTranscript = session.onTranscript(bumpTranscript);
    let raf = 0;
    let lastFrame = -1;
    const frame = () => {
      const live = session.isRunning;
      const t = session.now();
      const bucket = Math.floor(t * 10);
      if (live && bucket !== lastFrame) {
        lastFrame = bucket;
        setNow(t);
      }
      setRunning(live);
      if (live) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      offEngine();
      offTranscript();
      cancelAnimationFrame(raf);
    };
  }, [session]);

  // Debug/automation hook: scripts/capture.ts reads the live state from here.
  useEffect(() => {
    (window as unknown as { __kavachLive?: unknown }).__kavachLive = { snapshot, config: DETECTION, now };
  }, [snapshot, now]);

  const stopCurrent = useCallback(() => {
    sttHandle.current?.stop();
    sttHandle.current = null;
    session?.stop();
  }, [session]);

  useEffect(() => () => stopCurrent(), [stopCurrent]);

  const newSession = (bundle: CorpusBundle, worker: RetrievalWorker) =>
    new RealtimeSession(bundle, worker, DETECTION, (err) => setNotice(`Retrieval error: ${err instanceof Error ? err.message : String(err)}`));

  const playFixture = () => {
    if (boot.state !== "ready") return;
    const call = boot.bundle.corpus.fixtures.find((f) => f.id === fixtureId);
    if (!call) return;
    stopCurrent();
    setNotice(null);
    const s = newSession(boot.bundle, boot.worker);
    setNow(0);
    setSource({ mode: "fixture", fixtureId: call.id });
    setSession(s);
    s.playFixture(call);
  };

  const useMicrophone = () => {
    if (boot.state !== "ready" || !stt || stt.mode === "unavailable") return;
    stopCurrent();
    setNotice(null);
    const s = newSession(boot.bundle, boot.worker);
    const segments = new Map<string, { id: string; start: number }>();
    s.start();
    try {
      sttHandle.current = startStt({
        onDevice: stt.mode === "on-device",
        onUpdate: (u) => {
          const t = s.now();
          let meta = segments.get(u.key);
          if (!meta) {
            meta = { id: `mic-${segments.size + 1}`, start: Math.max(0, t - 0.5) };
            segments.set(u.key, meta);
          }
          s.pushSegment({ id: meta.id, speaker: "unknown", start: meta.start, end: Math.max(t, meta.start + 0.3), text: u.text, final: u.final });
        },
        onError: (message) => setNotice(`Speech recognition: ${message}. You can still play a fixture call.`),
      });
    } catch (err) {
      s.stop();
      setNotice(`Microphone unavailable (${err instanceof Error ? err.message : String(err)}). Play a fixture call instead.`);
      return;
    }
    setNow(0);
    setSource({ mode: "mic" });
    setSession(s);
  };

  const stop = () => {
    stopCurrent();
    setRunning(false);
  };

  const revealed = useMemo(() => (session ? session.transcript.revealed(now) : []),
    // transcriptVersion changes when live speech revises segments
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, now, transcriptVersion]);

  const buildPack = useCallback(
    async (incident: EvidenceIncident) => {
      if (!session || boot.state !== "ready") throw new Error("There is no call to export yet.");
      return buildEvidencePack({
        snapshot: session.engine.snapshot,
        segments: revealed.filter((r) => r.text).map((r) => ({ ...r.segment, text: r.text, end: Math.min(r.segment.end, now), final: true })),
        bundle: boot.bundle,
        source:
          source?.mode === "fixture"
            ? { mode: "fixture-replay", fixtureId: source.fixtureId, speechRecognition: "none (fixture transcript)" }
            : { mode: "live-microphone", fixtureId: null, speechRecognition: stt?.mode ?? "unknown" },
        incident,
        runtime: boot.worker.info,
        durationSeconds: now,
      });
    },
    [session, boot, revealed, source, stt, now],
  );

  const s = snapshot;
  const ready = boot.state === "ready";
  const fixtures = ready ? boot.bundle.corpus.fixtures : [];
  const activeFixture = source?.mode === "fixture" ? fixtures.find((f) => f.id === source.fixtureId) : undefined;

  return (
    <div className="min-h-screen">
      <SiteNav active="/live">
        <LatencyHeader ticks={s?.ticks ?? []} info={ready ? boot.worker.info : null} />
      </SiteNav>

      <main className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 px-4 py-4 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-5">
          <Panel
            title="Call source"
            right={
              <span className="tabular font-mono text-[13px] text-fg">
                {running && <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-danger" />}
                {clock(now)}
              </span>
            }
          >
            {boot.state === "loading" && <p className="text-[13px] text-muted">{boot.step}…</p>}
            {boot.state === "error" && (
              <p className="text-[13px] text-danger">
                On-device retrieval could not start: {boot.message}
              </p>
            )}
            {ready && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button className={button} type="button" onClick={useMicrophone} disabled={!stt || stt.mode === "unavailable"}>
                    Listen with microphone
                  </button>
                  {stt && (
                    <Chip tone={stt.mode === "on-device" ? "ok" : stt.mode === "unavailable" ? "neutral" : "warn"} title={stt.detail}>
                      speech: {stt.mode}
                    </Chip>
                  )}
                  {stt?.installable && (
                    <button
                      className={button}
                      type="button"
                      onClick={async () => {
                        setNotice((await installOnDeviceStt()) ? "On-device speech model installed." : "Could not install the on-device speech model.");
                        setStt(await detectStt());
                      }}
                    >
                      Install on-device speech
                    </button>
                  )}
                </div>
                {stt && <p className="text-[12px] text-faint">{stt.detail}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <select className="min-w-0 flex-1 rounded-md border border-line bg-ink px-2.5 py-1.5 text-[13px] text-fg" value={fixtureId} onChange={(e) => setFixtureId(e.target.value)}>
                    {fixtures.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.title}
                      </option>
                    ))}
                  </select>
                  <button className={button} type="button" onClick={playFixture}>
                    Play fixture call
                  </button>
                  <button className={button} type="button" onClick={stop} disabled={!running}>
                    Stop
                  </button>
                </div>
                {activeFixture && (
                  <p className="text-[12px] text-faint">
                    Synthetic call · labelled {activeFixture.label}
                    {activeFixture.family ? ` (${FAMILY_LABELS[activeFixture.family]})` : ""} · retrieval runs live on this device
                  </p>
                )}
                {notice && <p className="text-[12.5px] text-warn">{notice}</p>}
              </div>
            )}
          </Panel>

          <Panel title="Transcript">
            <TranscriptView lines={revealed} now={now} />
          </Panel>

          <Panel title="Caller claims · checked against ground truth">
            {ready ? <ClaimList claims={s?.claims ?? []} bundle={boot.bundle} /> : null}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:col-span-7">
          <CounterLineCard warning={s?.warning ?? null} watch={s?.watch ?? null} family={s?.current.family ?? "benign"} stage={s?.current.stage ?? "none"} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Panel title="Script retrieval · live match">
              {ready ? <MatchPanel tick={s?.ticks.at(-1) ?? null} bundle={boot.bundle} streak={s?.consecutive ?? 0} stagesMatched={s?.signalFamily ? Object.keys(s.familyEvidence[s.signalFamily]?.stages ?? {}).length : 0} /> : null}
            </Panel>
            <div className="flex min-w-0 flex-col gap-4">
              <Panel title="Coercion pressure">
                <PressureChart points={s?.pressure ?? []} now={now} warningAt={s?.warning?.at ?? null} stages={s?.stages ?? []} />
              </Panel>
              <Panel title="Scam stage">
                <StageTrack stages={s?.stages ?? []} />
              </Panel>
            </div>
          </div>

          <Panel title="Voice Circle">
            <VoiceCirclePanel alert={s?.impersonationAlert ?? null} />
          </Panel>

          <Panel title="Evidence pack">
            <EvidencePanel build={buildPack} disabled={!s || s.ticks.length === 0} />
          </Panel>
        </div>
      </main>
    </div>
  );
}
