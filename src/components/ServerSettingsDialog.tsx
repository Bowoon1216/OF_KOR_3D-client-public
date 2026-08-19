import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import { useState } from 'react';
import { healthz } from '../api/auth';
import { toMessage } from '../api/errors';
import {
  getApiBaseUrl,
  getDefaultApiBaseUrl,
  getWsBaseUrl,
  setApiBaseUrl,
  setWsBaseUrl,
} from '../config/env';
import {
  getMeasurementSettings,
  setMeasurementSettings,
  type MeasurementLocation,
  type NetworkType,
} from '../config/measurement';
import Button from './Button';
import TextField from './TextField';

/**
 * 서버 주소를 빌드 없이 바꾸기 위한 화면입니다.
 * 공유기에 붙은 여러 노트북으로 데모할 때 각 기기에서 서버 IP 를 지정해야 하기 때문입니다.
 */
export default function ServerSettingsDialog({ onClose }: { onClose: () => void }) {
  const [apiBase, setApiBase] = useState(getApiBaseUrl());
  const [wsBase, setWsBase] = useState(getWsBaseUrl() ?? '');
  const [measurement, setMeasurement] = useState(getMeasurementSettings());
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);

  const check = async () => {
    setChecking(true);
    setCheckResult(null);
    // 입력한 주소로 바로 확인할 수 있도록 먼저 저장합니다.
    setApiBaseUrl(apiBase);
    try {
      const result = await healthz();
      setCheckResult({ ok: true, message: `연결됨 (status: ${result.status})` });
    } catch (error) {
      setCheckResult({ ok: false, message: toMessage(error, '연결하지 못했습니다.') });
    } finally {
      setChecking(false);
    }
  };

  const save = () => {
    setApiBaseUrl(apiBase);
    setWsBaseUrl(wsBase.trim() ? wsBase : null);
    setMeasurementSettings(measurement);
    // 주소가 바뀌면 캐시된 응답과 토큰 유효성이 모두 의미를 잃으므로 통째로 다시 시작합니다.
    window.location.reload();
  };

  const reset = () => {
    setApiBaseUrl(null);
    setWsBaseUrl(null);
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-6">
      <section className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-y-auto border border-slate-200 bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-100 p-8">
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-blue-600">Settings</p>
            <h2 className="font-serif text-2xl italic">서버 연결</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-900 cursor-pointer"
            aria-label="닫기"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex flex-col gap-6 p-8">
          <TextField
            label="API Base URL"
            value={apiBase}
            onChange={(event) => setApiBase(event.target.value)}
            placeholder="http://localhost:8000"
            hint={`기본값: ${getDefaultApiBaseUrl()}`}
          />

          <TextField
            label="WebSocket Base URL (선택)"
            value={wsBase}
            onChange={(event) => setWsBase(event.target.value)}
            placeholder="ws://localhost:8000"
            hint="비워 두면 서버가 내려주는 wsUrl 을 그대로 씁니다. 리버스 프록시 뒤에서만 지정하세요."
          />

          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={() => void check()} disabled={checking}>
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : '연결 확인'}
            </Button>
            {checkResult && (
              <span
                className={`flex items-center gap-2 text-xs ${
                  checkResult.ok ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {checkResult.ok ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                {checkResult.message}
              </span>
            )}
          </div>

          <hr className="border-slate-100" />

          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Measurement
            </p>
            <p className="mb-6 text-xs leading-relaxed text-slate-400">
              전송 시간 베이스라인은 <code>scripts/measure.py</code> 로 잽니다. 여기서 남기는 것은
              브라우저에서만 알 수 있는 "입장 ~ 렌더링 완료" 표본입니다.
            </p>

            <div className="flex flex-col gap-6">
              <TextField
                label="Run ID"
                value={measurement.runId}
                onChange={(event) =>
                  setMeasurement((prev) => ({ ...prev, runId: event.target.value }))
                }
                placeholder="2026-09-15_commercial_r6_01"
                hint="비워 두면 서버가 표본을 DB 에 저장하지 않습니다."
              />

              <div className="grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    측정 위치
                  </span>
                  <select
                    value={measurement.location}
                    onChange={(event) =>
                      setMeasurement((prev) => ({
                        ...prev,
                        location: event.target.value as MeasurementLocation,
                      }))
                    }
                    className="h-12 border border-slate-200 bg-white px-4 text-sm focus:border-slate-900 focus:outline-none"
                  >
                    <option value="unknown">unknown</option>
                    <option value="campus">campus</option>
                    <option value="home">home</option>
                    <option value="mobile">mobile</option>
                  </select>
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    회선 종류
                  </span>
                  <select
                    value={measurement.networkType}
                    onChange={(event) =>
                      setMeasurement((prev) => ({
                        ...prev,
                        networkType: event.target.value as NetworkType,
                      }))
                    }
                    className="h-12 border border-slate-200 bg-white px-4 text-sm focus:border-slate-900 focus:outline-none"
                  >
                    <option value="unknown">unknown</option>
                    <option value="wired">wired</option>
                    <option value="wifi">wifi</option>
                    <option value="lte">lte</option>
                    <option value="5g">5g</option>
                  </select>
                </label>
              </div>

              <label className="flex items-center gap-3 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={measurement.cacheBust}
                  onChange={(event) =>
                    setMeasurement((prev) => ({ ...prev, cacheBust: event.target.checked }))
                  }
                />
                매 요청에 <code>?t=</code> 를 붙여 캐시를 무력화합니다
              </label>

              <label className="flex items-center gap-3 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={measurement.discardWarmup}
                  onChange={(event) =>
                    setMeasurement((prev) => ({ ...prev, discardWarmup: event.target.checked }))
                  }
                />
                첫 로드(워밍업)는 보고에서 제외합니다
              </label>
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-slate-100 p-8">
          <button
            type="button"
            onClick={reset}
            className="text-xs text-slate-400 underline underline-offset-4 hover:text-slate-900 cursor-pointer"
          >
            기본값으로 되돌리기
          </button>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose}>
              취소
            </Button>
            <Button onClick={save}>저장 후 새로고침</Button>
          </div>
        </footer>
      </section>
    </div>
  );
}
