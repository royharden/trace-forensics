import { useRef, useState, useCallback } from "react";
import { UploadCloud, FileJson } from "lucide-react";
import { importTrace, MAX_FILE_SIZE, MAX_STEPS } from "@/lib/importers";

interface Props {
  onIngest: (rawJson: string) => void;
  loading: boolean;
}

export function UploadDropzone({ onIngest, loading }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    if (file.size > MAX_FILE_SIZE) {
      setError(`File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit`);
      return;
    }
    const text = await file.text();
    try {
      const result = importTrace(text);
      if (result.trace.steps.length > MAX_STEPS) {
        setError(`Trace has ${result.trace.steps.length} steps, exceeding the ${MAX_STEPS} step limit`);
        return;
      }
      onIngest(text);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [onIngest]);

  return (
    <div className="w-full">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) handleFile(file);
        }}
        onClick={() => inputRef.current?.click()}
        className={`relative cursor-pointer rounded-xl border-2 border-dashed p-6 transition-all ${
          dragOver
            ? "border-violet-400 bg-violet-500/10"
            : "border-slate-600 bg-slate-800/40 hover:border-violet-500/50 hover:bg-slate-800/60"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".json,.jsonl,.txt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        <div className="flex flex-col items-center gap-2 text-center">
          {loading ? (
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
          ) : (
            <UploadCloud className="h-8 w-8 text-violet-400" />
          )}
          <p className="text-sm font-medium text-slate-200">
            {loading ? "Uploading..." : "Drop a trace file or click to browse"}
          </p>
          <p className="text-xs text-slate-500 flex items-center gap-1">
            <FileJson className="h-3 w-3" />
            JSON, OpenAI chat, or JSONL — max {MAX_FILE_SIZE / 1024 / 1024} MB, {MAX_STEPS} steps
          </p>
        </div>
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-400">{error}</p>
      )}
    </div>
  );
}
