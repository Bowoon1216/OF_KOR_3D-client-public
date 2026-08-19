import { Activity, Move, RefreshCcw, Server, Wifi, ZoomIn, ZoomOut } from 'lucide-react';
import type { NetworkProfile, RoomTelemetry } from '../api/types';
import type { ClockInfo } from '../realtime/RoomSocket';
import Toggle from './Toggle';

const gestures = [
  { id: 1, name: 'Grab (잡고 이동)', icon: Move, desc: '주먹을 쥐면 잡고, 그대로 움직이면 평행이동. 손을 펴면 놓기' },
  { id: 2, name: 'Rotate (회전)', icon: RefreshCcw, desc: '손을 편 채 손바닥/손등을 뒤집으면 좌우 회전, 손바닥을 아래로 눕히면 상하 회전' },
  { id: 3, name: 'Zoom In (확대)', icon: ZoomIn, desc: '엄지 + 검지로 집기' },
  { id: 4, name: 'Zoom Out (축소)', icon: ZoomOut, desc: '엄지 + 중지로 집기' },
];

/**
 * 9월 KOREN 연동 전까지는 `local` 입니다.
 * 그래서 "L2VPN Active" 같은 문구를 하드코딩하지 않고 서버가 주는 프로파일을 그대로 보여줍니다.
 */
const PROFILE_LABEL: Record<NetworkProfile, { label: string; tone: string }> = {
  local: { label: 'Local', tone: 'text-slate-400' },
  commercial: { label: 'Commercial', tone: 'text-amber-400' },
  koren: { label: 'KOREN L2VPN', tone: 'text-blue-400' },
  netem: { label: 'netem (emulated)', tone: 'text-purple-400' },
};

type ControlPanelProps = {
  gestureEnabled: boolean;
  onGestureEnabledChange: (enabled: boolean) => void;
  /** WebSocket `telemetry` frame. 2초마다 갱신됩니다. */
  telemetry?: RoomTelemetry | null;
  clock?: ClockInfo | null;
};

/** 표본이 없을 때 0 을 보여주면 "지연 0ms" 로 읽힙니다. 회색 대시로 둡니다. */
function metricText(value: number | null | undefined, stale: boolean | undefined, suffix = 'ms') {
  if (stale || value === null || value === undefined) return '–';
  return `${value.toFixed(value < 10 ? 1 : 0)}${suffix}`;
}

export default function ControlPanel({
  gestureEnabled,
  onGestureEnabledChange,
  telemetry = null,
  clock = null,
}: ControlPanelProps) {
  const profile = telemetry ? PROFILE_LABEL[telemetry.networkProfile] : null;
  const sync = telemetry?.sync;
  const stale = sync?.stale ?? true;
  // 목표 초과 비율이 대표 수치입니다. 이 과제의 주장은 평균이 아니라 분산에 있습니다.
  const overTarget = sync?.overTargetPct ?? 0;

  return (
    <aside className="w-80 bg-white flex flex-col shrink-0 overflow-y-auto">
      {/* Gesture Guide */}
      <div className="flex-1 p-8 border-b border-slate-100">
        <div className="flex flex-col mb-8">
           <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Interaction</span>
           <h2 className="font-serif text-2xl text-slate-900 italic">Gestures</h2>
        </div>

        <div className="mb-8 flex items-center justify-between gap-4 border border-slate-200 p-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-900">Gesture Control</div>
            <p className="mt-1 text-xs font-medium text-slate-500">
              {gestureEnabled ? '제스처로 모델을 조작합니다' : '제스처 인식이 꺼져 있습니다'}
            </p>
          </div>
          <Toggle
            checked={gestureEnabled}
            onChange={onGestureEnabledChange}
            label="제스처 인식 사용"
          />
        </div>

        <div className={`space-y-6 transition-opacity ${gestureEnabled ? '' : 'opacity-40'}`}>
          {gestures.map((g, idx) => (
            <div key={g.id} className="flex flex-col border-l-2 border-slate-200 pl-4">
               <div className="flex items-center gap-3 mb-1">
                 <span className="text-xs font-serif font-bold text-slate-400">0{idx + 1}.</span>
                 <g.icon className="w-4 h-4 text-slate-900" />
                 <span className="text-sm font-bold text-slate-900 tracking-wide">{g.name}</span>
               </div>
               <span className="text-xs text-slate-500 font-medium pl-10">{g.desc}</span>
            </div>
          ))}
        </div>

        <div className="mt-12 p-6 bg-slate-50 border border-slate-100">
          <div className="flex justify-between items-center mb-3">
            <span className="text-[10px] uppercase tracking-widest font-bold text-slate-900">AI Vision Engine</span>
            <div className={`w-2 h-2 rounded-full ${gestureEnabled ? 'bg-blue-500 animate-pulse' : 'bg-slate-300'}`}></div>
          </div>
          <p className="text-xs text-slate-500 leading-relaxed font-medium">
            {gestureEnabled
              ? 'MediaPipe engine is active and tracking your gestures in real-time.'
              : 'Gesture control is paused. Turn it on to control the model with your hand.'}
          </p>
        </div>
      </div>

      {/* Network Status — 전부 서버 telemetry frame 값입니다. */}
      <div className="p-8 bg-slate-900 text-white">
        <div className="flex flex-col mb-6">
           <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Telemetry</span>
           <h2 className="font-serif text-2xl italic">Network</h2>
        </div>
        <div className="space-y-6">
          <div className="flex justify-between items-center text-sm border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3 text-slate-300">
              <Server className="w-4 h-4" />
              <span className="text-[10px] uppercase tracking-widest font-bold">Sync p50</span>
            </div>
            <span className={`font-serif text-xl font-light ${stale ? 'text-slate-500' : ''}`}>
              {metricText(sync?.p50, stale)}
            </span>
          </div>

          <div className="flex justify-between items-center text-sm border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3 text-slate-300">
              <Activity className="w-4 h-4" />
              <span className="text-[10px] uppercase tracking-widest font-bold">Sync p95</span>
            </div>
            <span className={`font-serif text-xl font-light ${stale ? 'text-slate-500' : ''}`}>
              {metricText(sync?.p95, stale)}
            </span>
          </div>

          <div className="flex justify-between items-center text-sm border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3 text-slate-300">
              <Wifi className="w-4 h-4" />
              <span className="text-[10px] uppercase tracking-widest font-bold">Profile</span>
            </div>
            <span
              className={`text-[10px] uppercase tracking-widest font-bold ${profile?.tone ?? 'text-slate-500'}`}
            >
              {profile?.label ?? '–'}
            </span>
          </div>

          <div className="pt-2">
            <div className="flex justify-between text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-3">
              <span>Over {sync?.targetMs ?? 100}ms</span>
              <span>{stale ? '–' : `${overTarget.toFixed(1)}%`}</span>
            </div>
            <div className="w-full bg-slate-800 h-px">
              <div
                className={`h-0.5 ${overTarget > 5 ? 'bg-amber-400' : 'bg-blue-500'}`}
                style={{ width: `${Math.min(100, stale ? 0 : overTarget)}%` }}
              ></div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2 text-[10px] uppercase tracking-widest font-bold text-slate-400">
            <div>
              <div className="mb-1">Peers</div>
              <div className="font-serif text-base font-light text-white normal-case tracking-normal">
                {telemetry?.peers ?? '–'}
              </div>
            </div>
            <div>
              <div className="mb-1">Clock ±</div>
              {/* 시계 불확실성을 함께 보여주지 않으면 종단 지연 숫자를 방어할 수 없습니다. */}
              <div className="font-serif text-base font-light text-white normal-case tracking-normal">
                {clock && Number.isFinite(clock.uncertaintyMs)
                  ? `${clock.uncertaintyMs.toFixed(1)}ms`
                  : '–'}
              </div>
            </div>
            <div>
              <div className="mb-1">Relay p50</div>
              <div className="font-serif text-base font-light text-white normal-case tracking-normal">
                {metricText(telemetry?.relay?.p50, telemetry?.relay?.stale)}
              </div>
            </div>
            <div>
              <div className="mb-1">Coalesced</div>
              {/* 병합 비율은 지연 수치의 편향을 함께 공개하는 값입니다. */}
              <div className="font-serif text-base font-light text-white normal-case tracking-normal">
                {telemetry ? `${telemetry.coalescedPct.toFixed(1)}%` : '–'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
