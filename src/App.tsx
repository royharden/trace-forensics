import { useState, useEffect, useCallback, useRef } from "react";
import {
  ScanLine, AlertCircle, Loader2, X, FlaskConical, ChevronDown, ChevronRight,
} from "lucide-react";

import type {
  RunRecord, StepRecord, ScanBatchRecord, IncidentRecord,
  ScanMode, SeverityPolicy, LLMCostParams,
} from "@/lib/types";
import { DEFAULT_POLICY, PRESETS, assess } from "@/lib/assess";
import type { StepAnswers } from "@/lib/assess";
import {
  ingestTrace, scanRun, generateReport, fetchRuns, fetchSteps,
  fetchScanBatches, fetchIncidents, saveAssessment, hideRun,
  parseJevResponses, replayAssess, ReplayModeError,
} from "@/lib/api";
import { SAMPLE_TRACES, getSampleTrace } from "@/lib/sampleTraces";

import { UploadDropzone } from "@/components/UploadDropzone";
import { SampleTraces } from "@/components/SampleTraces";
import { ModeToggle } from "@/components/ModeToggle";
import { RunsList } from "@/components/RunsList";
import { Timeline } from "@/components/Timeline";
import { StepInspector } from "@/components/StepInspector";
import { IncidentPanel } from "@/components/IncidentPanel";
import { Stats } from "@/components/Stats";
import { PolicySliders } from "@/components/PolicySliders";

const POLICY_STORAGE_KEY = "trace-forensics-policy";
const LLM_COST_STORAGE_KEY = "trace-forensics-llm-cost";

const DEFAULT_LLM_COST: LLMCostParams = {
  inputCostPerM: 2.5,
  outputCostPerM: 10,
  outputTokensPerStep: 150,
};

function loadPolicy(): SeverityPolicy {
  try {
    const stored = localStorage.getItem(POLICY_STORAGE_KEY);
    if (stored) return { ...DEFAULT_POLICY, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_POLICY;
}

function loadLLMCost(): LLMCostParams {
  try {
    const stored = localStorage.getItem(LLM_COST_STORAGE_KEY);
    if (stored) return { ...DEFAULT_LLM_COST, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_LLM_COST;
}

export default function App() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [batches, setBatches] = useState<ScanBatchRecord[]>([]);
  const [incidents, setIncidents] = useState<IncidentRecord[]>([]);
  const [mode, setMode] = useState<ScanMode>("live");
  const [policy, setPolicy] = useState<SeverityPolicy>(loadPolicy);
  const [llmCostParams, setLlmCostParams] = useState<LLMCostParams>(loadLLMCost);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replayBanner, setReplayBanner] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<StepRecord | null>(null);
  const [stepAnswers, setStepAnswers] = useState<Map<number, StepAnswers>>(new Map());
  const [scanCosts, setScanCosts] = useState<Map<string, number>>(new Map());
  const [incidentCounts, setIncidentCounts] = useState<Map<string, number>>(new Map());
  const [report, setReport] = useState<string | null>(null);
  const [reportMock, setReportMock] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showLLMParams, setShowLLMParams] = useState(false);

  const isFirstLoad = useRef(true);

  // Load runs on mount
  useEffect(() => {
    loadRuns();
    isFirstLoad.current = false;
  }, []);

  // Persist policy
  useEffect(() => {
    localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(policy));
  }, [policy]);

  // Persist LLM cost params
  useEffect(() => {
    localStorage.setItem(LLM_COST_STORAGE_KEY, JSON.stringify(llmCostParams));
  }, [llmCostParams]);

  // Re-assess when policy changes and we have answers
  useEffect(() => {
    if (stepAnswers.size > 0 && steps.length > 0 && selectedRun) {
      reAssess();
    }
  }, [policy]);

  const loadRuns = async () => {
    try {
      const data = await fetchRuns();
      setRuns(data);
      // Load incident counts and scan costs
      const incCounts = new Map<string, number>();
      const costs = new Map<string, number>();
      for (const run of data) {
        const incs = await fetchIncidents(run.id);
        incCounts.set(run.id, incs.length);
        const batchesData = await fetchScanBatches(run.id);
        const totalCost = batchesData.reduce((s, b) => s + (b.cost_usd || 0), 0);
        costs.set(run.id, totalCost);
      }
      setIncidentCounts(incCounts);
      setScanCosts(costs);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleIngest = async (rawJson: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await ingestTrace(rawJson);
      await loadRuns();
      // Auto-scan the new run
      const newRun = await fetchRuns();
      const run = newRun.find((r) => r.id === result.run_id);
      if (run) {
        setSelectedRun(run);
        await loadRunDetails(run);
        if (mode === "live") {
          await handleScan(run);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadSample = async (sampleId: string) => {
    const sample = getSampleTrace(sampleId);
    if (!sample) return;
    setLoading(true);
    setError(null);
    setReplayBanner(null);
    try {
      const traceJson = JSON.stringify(sample.trace);
      const result = await ingestTrace(traceJson);
      await loadRuns();
      const newRuns = await fetchRuns();
      const run = newRuns.find((r) => r.id === result.run_id);
      if (run) {
        setSelectedRun(run);
        await loadRunDetails(run);
        if (mode === "live") {
          await handleScan(run);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleScan = async (run: RunRecord) => {
    setScanning(true);
    setError(null);
    setReplayBanner(null);
    try {
      const result = await scanRun(run.id);
      await loadRunDetails(run);
      // Update cost
      setScanCosts((prev) => {
        const next = new Map(prev);
        next.set(run.id, result.total_cost_usd);
        return next;
      });
    } catch (e) {
      if (e instanceof ReplayModeError) {
        setReplayBanner(e.message + " — switching to Replay mode for sample traces.");
        setMode("replay");
        // If this is a sample trace, do replay assessment
        await handleReplay(run);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setScanning(false);
    }
  };

  const handleReplay = async (run: RunRecord) => {
    // Find matching sample trace by agent_name and user_goal
    const sample = SAMPLE_TRACES.find(
      (s) => s.trace.agent_name === run.agent_name && s.trace.user_goal === run.user_goal,
    );
    if (!sample) {
      setError("No replay data available for this trace. Try a bundled sample.");
      return;
    }

    const result = replayAssess(sample.id, policy);
    if (!result) return;

    // Update steps with severity, run risk score and incidents
    await saveAssessment(run.id, result);

    // Reload
    await loadRunDetails(run);
    await loadRuns();
  };

  const reAssess = async () => {
    if (!selectedRun || stepAnswers.size === 0) return;
    const stepIndices = steps.map((s) => s.idx);
    const result = assess(stepAnswers, stepIndices, policy);
    await saveAssessment(selectedRun.id, result);
    await loadRunDetails(selectedRun);
    await loadRuns();
  };

  const loadRunDetails = async (run: RunRecord) => {
    try {
      const [stepsData, batchesData, incData] = await Promise.all([
        fetchSteps(run.id),
        fetchScanBatches(run.id),
        fetchIncidents(run.id),
      ]);
      setSteps(stepsData);
      setBatches(batchesData);
      setIncidents(incData);
      setStepAnswers(parseJevResponses(batchesData));
      setReport(incData.find((i) => i.report)?.report || null);
      setReportMock(false);
      setSelectedStep(null);

      // Update incident count
      setIncidentCounts((prev) => {
        const next = new Map(prev);
        next.set(run.id, incData.length);
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleSelectRun = async (run: RunRecord) => {
    setSelectedRun(run);
    setReplayBanner(null);
    await loadRunDetails(run);
  };

  const handleDeleteRun = async (runId: string) => {
    try {
      hideRun(runId);
      if (selectedRun?.id === runId) {
        setSelectedRun(null);
        setSteps([]);
        setBatches([]);
        setIncidents([]);
      }
      await loadRuns();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleWriteReport = async () => {
    if (!selectedRun) return;
    setReportLoading(true);
    try {
      const result = await generateReport(selectedRun.id);
      setReport(result.report);
      setReportMock(result.mock);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReportLoading(false);
    }
  };

  const handleStepClick = (step: StepRecord) => {
    setSelectedStep(step);
  };

  const selectedStepBatch = selectedStep?.batch_id
    ? batches.find((b) => b.id === selectedStep.batch_id) || null
    : null;
  const selectedStepAnswers = selectedStep ? stepAnswers.get(selectedStep.idx) || null : null;

  return (
    <div className="min-h-screen bg-[#0a0d14] text-slate-200 grid-bg">
      {/* Header */}
      <header className="border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-30">
        <div className="mx-auto max-w-7xl px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 border border-violet-500/30">
                <ScanLine className="h-5 w-5 text-violet-400" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-100">
                  Trace Forensics
                </h1>
                <p className="text-[10px] text-slate-500">
                  See what your agent really did
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ModeToggle mode={mode} onChange={setMode} />
            </div>
          </div>
        </div>
      </header>

      {/* Replay banner */}
      {replayBanner && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <div className="mx-auto flex max-w-7xl items-center gap-2 text-xs text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{replayBanner}</span>
            <button onClick={() => setReplayBanner(null)} className="ml-auto text-amber-400 hover:text-amber-200">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-2">
          <div className="mx-auto flex max-w-7xl items-center gap-2 text-xs text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-200">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-6">
        {!selectedRun ? (
          /* Landing / Upload view */
          <div className="space-y-6 animate-fade-in">
            <div className="text-center py-8">
              <h2 className="text-3xl font-bold text-slate-100 sm:text-4xl">
                Trace Forensics: see what your agent really did.
              </h2>
              <p className="mt-3 text-sm text-slate-400 max-w-2xl mx-auto">
                Upload an agent run trace and get an interactive forensic timeline.
                Jev screens every step for risk — destructive actions, covering tracks,
                self-modification, prompt injection, and scope creep.
              </p>
            </div>

            <div className="mx-auto max-w-2xl space-y-4">
              <UploadDropzone onIngest={handleIngest} loading={loading || scanning} />
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Or load a bundled sample trace:
                </p>
                <SampleTraces onLoad={handleLoadSample} loading={loading || scanning} />
              </div>
            </div>

            {runs.length > 0 && (
              <div className="mx-auto max-w-2xl">
                <h3 className="mb-2 text-sm font-semibold text-slate-300">Previous Runs</h3>
                <RunsList
                  runs={runs}
                  selectedId={null}
                  onSelect={handleSelectRun}
                  onDelete={handleDeleteRun}
                  incidentCounts={incidentCounts}
                  scanCosts={scanCosts}
                />
              </div>
            )}
          </div>
        ) : (
          /* Main analysis view */
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
            {/* Sidebar */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Runs</h3>
                <button
                  onClick={() => setSelectedRun(null)}
                  className="text-xs text-violet-400 hover:text-violet-300"
                >
                  + New
                </button>
              </div>
              <RunsList
                runs={runs}
                selectedId={selectedRun.id}
                onSelect={handleSelectRun}
                onDelete={handleDeleteRun}
                incidentCounts={incidentCounts}
                scanCosts={scanCosts}
              />

              {/* Policy sliders */}
              <div className="pt-2">
                <button
                  onClick={() => setShowPolicy(!showPolicy)}
                  className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
                >
                  <span>Severity Policy</span>
                  {showPolicy ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                {showPolicy && (
                  <div className="mt-2">
                    <PolicySliders policy={policy} onChange={setPolicy} />
                  </div>
                )}
              </div>

              {/* LLM cost params */}
              <div className="pt-2">
                <button
                  onClick={() => setShowLLMParams(!showLLMParams)}
                  className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
                >
                  <span>LLM Cost Params</span>
                  {showLLMParams ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                {showLLMParams && (
                  <div className="mt-2 space-y-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
                    {([
                      { key: "inputCostPerM", label: "Input $/M tokens", step: 0.1 },
                      { key: "outputCostPerM", label: "Output $/M tokens", step: 0.5 },
                      { key: "outputTokensPerStep", label: "Output tokens/step", step: 10 },
                    ] as const).map((f) => (
                      <div key={f.key} className="flex items-center gap-2">
                        <span className="w-28 text-[10px] text-slate-400">{f.label}</span>
                        <input
                          type="number"
                          step={f.step}
                          value={llmCostParams[f.key]}
                          onChange={(e) => setLlmCostParams({ ...llmCostParams, [f.key]: parseFloat(e.target.value) || 0 })}
                          className="w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-300"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Main content */}
            <div className="space-y-4 animate-fade-in">
              {/* Run header */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold text-slate-100">{selectedRun.agent_name}</h2>
                    <p className="text-sm text-slate-400">{selectedRun.user_goal}</p>
                    <div className="mt-2 flex items-center gap-3 text-xs text-slate-600">
                      <span>{selectedRun.step_count} steps</span>
                      <span>·</span>
                      <span>{selectedRun.source_format}</span>
                      <span>·</span>
                      <span>Risk score: {selectedRun.risk_score}</span>
                      {scanning && (
                        <span className="flex items-center gap-1 text-violet-400">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          scanning...
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {mode === "replay" && !scanning && (
                      <button
                        onClick={() => handleReplay(selectedRun)}
                        className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
                      >
                        Replay scan
                      </button>
                    )}
                    {mode === "live" && !scanning && steps.some((s) => !s.batch_id && (s.type === "tool_call" || (s.type === "message" && s.actor === "assistant"))) && (
                      <button
                        onClick={() => handleScan(selectedRun)}
                        className="rounded-lg bg-violet-500/20 px-3 py-1.5 text-xs font-medium text-violet-300 hover:bg-violet-500/30"
                      >
                        Scan with Jev
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Incident panel */}
              <IncidentPanel
                incidents={incidents}
                onWriteReport={handleWriteReport}
                reportLoading={reportLoading}
                report={report}
                reportMock={reportMock}
              />

              {/* Stats toggle */}
              <button
                onClick={() => setShowStats(!showStats)}
                className="flex w-full items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
              >
                <span className="flex items-center gap-2">
                  <FlaskConical className="h-3.5 w-3.5 text-violet-400" />
                  Statistics & Cost Analysis
                </span>
                {showStats ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              {showStats && (
                <Stats steps={steps} batches={batches} llmCostParams={llmCostParams} />
              )}

              {/* Timeline */}
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <h3 className="mb-3 text-sm font-semibold text-slate-200">Timeline</h3>
                <Timeline
                  steps={steps}
                  incidents={incidents}
                  onStepClick={handleStepClick}
                  selectedStepIdx={selectedStep?.idx || null}
                />
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Step inspector drawer */}
      <StepInspector
        step={selectedStep}
        answers={selectedStepAnswers}
        batch={selectedStepBatch}
        onClose={() => setSelectedStep(null)}
      />
    </div>
  );
}
