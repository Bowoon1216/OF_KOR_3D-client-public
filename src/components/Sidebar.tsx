import { Hand, HandMetal, Mic, MicOff, Video, VideoOff } from 'lucide-react';
import type { Participant } from '../api/types';
import { StreamVideo, useLocalCamera } from '../media/LocalCamera';
import { usePeerVideo } from '../media/PeerVideo';
import type { ConnectionStatus } from '../realtime/RoomSocket';

type SidebarProps = {
  roster: Participant[];
  /** 내 참가자 id. 내 타일에서만 마이크/카메라를 끄고 켤 수 있습니다. */
  myId?: string | null;
  status: ConnectionStatus;
  onPresenceChange?: (mic: boolean, vid: boolean) => void;
};

const STATUS_DOT: Record<ConnectionStatus, string> = {
  idle: 'bg-slate-300',
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-blue-500 animate-pulse',
  reconnecting: 'bg-amber-500 animate-pulse',
  closed: 'bg-slate-400',
};

export default function Sidebar({ roster, myId, status, onPresenceChange }: SidebarProps) {
  // 내 타일에는 손 인식과 같은 웹캠 스트림을 그대로 붙입니다. (getUserMedia 는 한 번만 호출됩니다)
  const camera = useLocalCamera();
  // 다른 참가자 영상은 WebRTC 로 직접 받습니다. 서버는 시그널만 중계합니다.
  const peers = usePeerVideo();

  return (
    <aside className="w-80 bg-slate-50 border-r border-slate-100 flex flex-col shrink-0">
      <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-white">
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Session</span>
          <h2 className="font-serif text-2xl text-slate-900 italic">Participants</h2>
        </div>
        <div className={`w-2 h-2 rounded-full ${STATUS_DOT[status]}`}></div>
      </div>
      <div className="flex-1 overflow-y-auto p-8 space-y-8">
        {roster.length === 0 && (
          <p className="text-xs font-medium text-slate-400">
            {status === 'connected' ? '아직 참가자가 없습니다.' : '접속 중...'}
          </p>
        )}
        {roster.map((p, index) => {
          const isMe = p.id === myId;
          const stream = isMe ? camera.stream : peers.streams[p.id] ?? null;
          // 카메라가 켜져 있다고 알려온 사람만 영상으로 봅니다. (내 타일은 스트림이 곧 진실입니다)
          const feed = stream && (isMe || p.vid) ? stream : null;
          const waiting = !feed && !isMe && p.vid;
          return (
            <div
              key={p.id}
              className={`group relative bg-white border aspect-[4/3] flex flex-col shadow-sm ${
                isMe ? 'border-blue-200' : 'border-slate-100'
              } ${p.active ? '' : 'opacity-60'}`}
            >
              {/*
                내 화면은 웹캠을 바로 붙이고(거울상), 다른 참가자는 WebRTC 로 받은 스트림을
                그대로 보여줍니다. presence 의 vid 가 꺼졌으면 트랙이 남아 있어도 이름 타일로
                돌아갑니다. 상대가 카메라를 끈 직후 마지막 프레임이 얼어붙는 것을 막습니다.
              */}
              {feed ? (
                <StreamVideo
                  stream={feed}
                  className={`absolute inset-0 h-full w-full object-cover bg-slate-900 ${
                    isMe ? 'scale-x-[-1]' : ''
                  }`}
                />
              ) : (
                <div className="absolute inset-0 bg-slate-50 flex flex-col items-center justify-center gap-2">
                  <div className="text-4xl font-serif font-light text-slate-300 italic">
                    {p.name.slice(0, 1)}
                  </div>
                  {waiting && (
                    <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-400">
                      <Video className="w-3 h-3" />
                      {peers.states[p.id] === 'failed' ? 'Connection failed' : 'Connecting...'}
                    </span>
                  )}
                  {isMe && camera.status === 'denied' && (
                    <span className="text-[9px] font-bold uppercase tracking-widest text-red-400">
                      Camera blocked
                    </span>
                  )}
                </div>
              )}

              {/* Overlay Info */}
              <div className="relative z-10 p-5 mt-auto bg-gradient-to-t from-white via-white/90 to-transparent flex flex-col justify-end h-full opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="border-l-2 border-slate-900 pl-4 mb-4">
                  <span className="text-sm font-bold text-slate-900 tracking-wide block mb-1">
                    {p.name}
                    {isMe && ' (나)'}
                    {p.isGuest && ' · Guest'}
                  </span>
                  {/* roleLabel 은 서버가 그대로 쓰라고 내려주는 문자열입니다. */}
                  <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">
                    {p.roleLabel}
                  </span>
                </div>
                <div className="flex gap-4 items-center">
                  <button
                    type="button"
                    disabled={!isMe}
                    onClick={() => onPresenceChange?.(!p.mic, p.vid)}
                    className="flex items-center gap-2 disabled:cursor-default cursor-pointer"
                  >
                    {p.mic ? (
                      <Mic className="w-4 h-4 text-slate-900" />
                    ) : (
                      <MicOff className="w-4 h-4 text-slate-300" />
                    )}
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Audio</span>
                  </button>
                  <div className="w-px h-3 bg-slate-200"></div>
                  <button
                    type="button"
                    disabled={!isMe}
                    // 카메라 on/off 가 곧 presence 입니다. presence frame 은 스트림 상태를 보고 나갑니다.
                    onClick={() => (camera.stream ? camera.stop() : void camera.start())}
                    className="flex items-center gap-2 disabled:cursor-default cursor-pointer"
                  >
                    {p.vid ? (
                      <Video className="w-4 h-4 text-slate-900" />
                    ) : (
                      <VideoOff className="w-4 h-4 text-slate-300" />
                    )}
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Video</span>
                  </button>
                </div>
              </div>

              <div className="absolute top-4 left-4 z-10 flex items-center gap-2 group-hover:opacity-0 transition-opacity">
                {/* tracking:false 는 웹캠 인식에서 손이 벗어났다는 뜻입니다. */}
                {p.tracking ? (
                  <Hand className="w-3.5 h-3.5 text-blue-500" />
                ) : (
                  <HandMetal className="w-3.5 h-3.5 text-slate-300" />
                )}
                {p.isHost && (
                  <span className="text-[9px] font-bold uppercase tracking-widest text-blue-600">Host</span>
                )}
              </div>

              <div className="absolute top-4 right-4 z-10 text-[10px] font-bold font-serif text-slate-400 group-hover:opacity-0 transition-opacity">
                {String(index + 1).padStart(2, '0')}.
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
