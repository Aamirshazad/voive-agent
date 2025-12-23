import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Transcription, PrebuiltVoice } from './types';
import { decode, decodeAudioData, createPcmBlob } from './utils/audioUtils';
import Visualizer from './components/Visualizer';

const getSystemInstruction = (strictMode: boolean) => `
You are Professor Sterling, a sophisticated, high-end English language coach specialized in US English.
Your voice is warm, authoritative, and perfectly enunciated.

**TEACHING PROTOCOL:**
Mode: ${strictMode ? 'STRICT' : 'SUPPORTIVE'}
${strictMode 
  ? 'Interrupt immediately for phonetic errors. Focus intensely on vowel sounds like /æ/ vs /ɛ/, rhotic R sounds, and word stress. If the user mispronounces something, ask them to repeat it three times.' 
  : 'Focus on natural conversational flow. Correct errors only if they hinder understanding. Encourage idiomatic expressions.'}

**VISION PROTOCOL:**
You can see the student. Comment on their mouth shape or facial tension if it affects their pronunciation (e.g., "Drop your jaw more for the 'O' in 'Thought'"). 

**STYLE:**
Keep responses concise. Be encouraging but demand excellence. Use the student's name if they provide it.
`;

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [strictMode, setStrictMode] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState<string>(PrebuiltVoice.Zephyr);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [error, setError] = useState<string | null>(null);

  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const inputGainRef = useRef<GainNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoIntervalRef = useRef<number | null>(null);
  
  const sessionRef = useRef<any>(null);
  const inputBufferRef = useRef('');
  const outputBufferRef = useRef('');
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcriptions]);

  const cleanupAudio = () => {
    try {
      if (inputCtxRef.current?.state !== 'closed') inputCtxRef.current?.close();
      if (outputCtxRef.current?.state !== 'closed') outputCtxRef.current?.close();
    } catch (e) {}
    inputCtxRef.current = null;
    outputCtxRef.current = null;
  };

  const cleanupVideo = () => {
    if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  };

  const stopSession = useCallback(() => {
    try { sessionRef.current?.close(); } catch (e) {}
    sessionRef.current = null;
    cleanupAudio();
    cleanupVideo();
    sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
    sourcesRef.current.clear();
    setIsActive(false);
    setIsCameraOn(false);
  }, []);

  const sendVideoFrame = (session: any) => {
    if (!videoRef.current || !canvasRef.current || !isCameraOn) return;
    const ctx = canvasRef.current.getContext('2d');
    const vid = videoRef.current;
    if (vid.readyState === 2 || vid.readyState === 4) {
      canvasRef.current.width = 320;
      canvasRef.current.height = 240;
      ctx?.drawImage(vid, 0, 0, 320, 240);
      const base64 = canvasRef.current.toDataURL('image/jpeg', 0.6).split(',')[1];
      session.sendRealtimeInput({ media: { mimeType: 'image/jpeg', data: base64 } });
    }
  };

  const startSession = async () => {
    try {
      setError(null);
      if (!process.env.API_KEY) throw new Error("API Key missing");

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      const iCtx = new AC({ sampleRate: 16000 });
      const oCtx = new AC({ sampleRate: 24000 });
      
      inputCtxRef.current = iCtx;
      outputCtxRef.current = oCtx;
      inputGainRef.current = iCtx.createGain();
      outputGainRef.current = oCtx.createGain();
      outputGainRef.current.connect(oCtx.destination);

      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      if (isCameraOn) {
        try {
          const vStream = await navigator.mediaDevices.getUserMedia({ video: true });
          streamRef.current = vStream;
          if (videoRef.current) {
            videoRef.current.srcObject = vStream;
          }
        } catch (e) {
          setIsCameraOn(false);
        }
      }

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setIsActive(true);
            const source = iCtx.createMediaStreamSource(micStream);
            const processor = iCtx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              if (isMuted) return;
              const data = e.inputBuffer.getChannelData(0);
              const blob = createPcmBlob(data);
              sessionPromise.then(s => s.sendRealtimeInput({ media: blob }));
            };
            source.connect(inputGainRef.current!);
            inputGainRef.current!.connect(processor);
            processor.connect(iCtx.destination);

            if (isCameraOn) {
              videoIntervalRef.current = window.setInterval(() => {
                sessionPromise.then(s => sendVideoFrame(s));
              }, 1000);
            }
          },
          onmessage: async (msg: LiveServerMessage) => {
            const audioData = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputCtxRef.current) {
              const buffer = await decodeAudioData(decode(audioData), outputCtxRef.current, 24000, 1);
              const src = outputCtxRef.current.createBufferSource();
              src.buffer = buffer;
              src.connect(outputGainRef.current!);
              
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtxRef.current.currentTime);
              src.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              
              sourcesRef.current.add(src);
              src.onended = () => sourcesRef.current.delete(src);
            }

            if (msg.serverContent?.inputTranscription?.text) inputBufferRef.current += msg.serverContent.inputTranscription.text;
            if (msg.serverContent?.outputTranscription?.text) outputBufferRef.current += msg.serverContent.outputTranscription.text;

            if (msg.serverContent?.turnComplete) {
              const u = inputBufferRef.current;
              const a = outputBufferRef.current;
              if (u || a) {
                setTranscriptions(prev => [...prev, 
                  ...(u ? [{text: u, sender: 'user' as const, timestamp: Date.now()}] : []),
                  ...(a ? [{text: a, sender: 'ai' as const, timestamp: Date.now()}] : [])
                ]);
              }
              inputBufferRef.current = '';
              outputBufferRef.current = '';
            }

            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
             setError("Session interrupted. Retrying...");
             stopSession();
          },
          onclose: () => setIsActive(false)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: getSystemInstruction(strictMode),
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (e: any) {
      setError(e.message || "Failed to start session");
      setIsActive(false);
    }
  };

  const toggleMute = () => setIsMuted(prev => !prev);
  const toggleCamera = () => setIsCameraOn(prev => !prev);

  return (
    <div className="h-screen w-full bg-zinc-950 text-zinc-100 font-sans flex flex-col overflow-hidden">
      {/* HEADER */}
      <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-8 bg-zinc-950/50 backdrop-blur-xl z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6 text-white" stroke="currentColor" strokeWidth="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          </div>
          <div>
            <h1 className="font-display font-bold text-xl leading-none">Professor Sterling</h1>
            <p className="text-[10px] text-zinc-500 uppercase tracking-[0.2em] font-bold mt-1">Advanced Language Lab</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
           {!isActive && (
             <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800">
               <span className="text-[10px] font-bold text-zinc-500 uppercase">Voice</span>
               <select 
                 value={selectedVoice} 
                 onChange={e => setSelectedVoice(e.target.value)}
                 className="bg-transparent text-xs font-semibold outline-none text-zinc-300 cursor-pointer hover:text-white transition-colors"
               >
                 {Object.values(PrebuiltVoice).map(v => <option key={v} value={v}>{v}</option>)}
               </select>
             </div>
           )}
           <button 
             onClick={() => setStrictMode(!strictMode)}
             className={`px-4 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all duration-300 ${
               strictMode ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300'
             }`}
           >
             {strictMode ? 'Strict Mode Active' : 'Enable Strict Mode'}
           </button>
        </div>
      </header>

      {/* VIEWPORT */}
      <main className="flex-1 flex overflow-hidden">
        {/* STAGE */}
        <div className="flex-1 p-6 flex flex-col gap-6 relative">
          
          {/* AI AVATAR AREA */}
          <div className="flex-1 rounded-3xl bg-zinc-900/40 border border-zinc-800/50 flex flex-col items-center justify-center relative shadow-2xl overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/5 to-transparent pointer-events-none" />
            
            <div className={`relative z-10 transition-all duration-700 ${isActive ? 'scale-110' : 'scale-100'}`}>
               <div className={`w-48 h-48 rounded-full border-4 flex items-center justify-center transition-all duration-500 ${isActive ? 'border-indigo-500 shadow-[0_0_50px_-12px_rgba(79,70,229,0.5)]' : 'border-zinc-800'}`}>
                  <div className="w-40 h-40 rounded-full bg-zinc-950 overflow-hidden relative border border-white/5">
                    <img src={`https://api.dicebear.com/9.x/notionists/svg?seed=${selectedVoice}&backgroundColor=0c0c0e`} alt="Professor" className="w-full h-full object-cover opacity-90" />
                    {isActive && <div className="absolute inset-0 bg-indigo-500/10 animate-pulse" />}
                  </div>
               </div>
               {isActive && (
                 <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 px-4 py-1 bg-indigo-600 rounded-full text-[10px] font-black uppercase tracking-tighter shadow-lg">
                   Live
                 </div>
               )}
            </div>

            <div className="mt-12 w-80 h-16 bg-zinc-950/40 backdrop-blur rounded-2xl border border-white/5 flex items-center px-6">
              <Visualizer isActive={isActive} audioContext={outputCtxRef.current} gainNode={outputGainRef.current} color="#6366f1" />
            </div>

            {!isActive && (
              <div className="absolute inset-0 bg-zinc-950/80 backdrop-blur flex flex-col items-center justify-center z-20">
                <h3 className="text-3xl font-display font-bold mb-3">Begin Your Session</h3>
                <p className="text-zinc-500 max-w-sm text-center text-sm mb-8 leading-relaxed">Professor Sterling is ready to help you perfect your American English pronunciation and fluency.</p>
                <button 
                  onClick={startSession}
                  className="group px-10 py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-2xl transition-all shadow-xl shadow-indigo-600/30 flex items-center gap-3 hover:-translate-y-1"
                >
                  <span className="text-lg">Start Teaching</span>
                  <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                </button>
              </div>
            )}
            
            {error && (
              <div className="absolute bottom-6 left-6 right-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2">
                <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                {error}
                <button onClick={() => setError(null)} className="ml-auto text-xs font-bold uppercase hover:text-white">Close</button>
              </div>
            )}
          </div>

          {/* USER FEED AREA */}
          <div className="h-64 rounded-3xl bg-zinc-900/40 border border-zinc-800/50 overflow-hidden relative shadow-xl shrink-0">
             <canvas ref={canvasRef} className="hidden" />
             <video 
               ref={videoRef} 
               className={`w-full h-full object-cover transition-opacity duration-1000 ${isCameraOn ? 'opacity-100' : 'opacity-10'}`} 
               autoPlay playsInline muted 
             />
             
             <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/80 via-transparent to-transparent" />
             
             <div className="absolute bottom-6 left-6 right-6 flex items-center justify-between">
                <div className="flex gap-2">
                   <button onClick={toggleCamera} className={`p-3 rounded-xl border backdrop-blur-md transition-all ${isCameraOn ? 'bg-indigo-600 text-white border-indigo-400 shadow-lg' : 'bg-zinc-800/80 text-zinc-400 border-zinc-700 hover:bg-zinc-700'}`}>
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                   </button>
                   <button onClick={toggleMute} className={`p-3 rounded-xl border backdrop-blur-md transition-all ${isMuted ? 'bg-red-500 text-white border-red-400 shadow-lg' : 'bg-zinc-800/80 text-zinc-400 border-zinc-700 hover:bg-zinc-700'}`}>
                      {isMuted ? <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636"></path></svg> 
                      : <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>}
                   </button>
                </div>
                
                <div className="flex-1 max-w-[200px] h-10 px-4 flex items-center">
                   <Visualizer isActive={isActive && !isMuted} audioContext={inputCtxRef.current} gainNode={inputGainRef.current} color="#ffffff" />
                </div>
             </div>
          </div>
        </div>

        {/* LABORATORY / TRANSCRIPT */}
        <div className="w-[450px] bg-zinc-950 border-l border-zinc-800/50 flex flex-col shrink-0">
          <div className="h-16 border-b border-zinc-800/50 flex items-center justify-between px-6 bg-zinc-950/80 backdrop-blur-xl">
             <h3 className="text-[10px] font-black uppercase tracking-[0.25em] text-zinc-500">Laboratory Output</h3>
             <div className="flex gap-4">
                <button onClick={() => setTranscriptions([])} className="text-[10px] font-bold text-zinc-700 hover:text-zinc-400 transition-colors">WIPE DATA</button>
             </div>
          </div>
          
          <div className="flex-1 overflow-y-auto p-6 space-y-8 scroll-smooth">
            {transcriptions.length === 0 && (
               <div className="h-full flex flex-col items-center justify-center opacity-20 select-none">
                  <svg className="w-12 h-12 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                  <p className="text-xs font-mono uppercase tracking-widest">Awaiting Audio Input...</p>
               </div>
            )}
            {transcriptions.map((t, i) => (
              <div key={i} className={`flex flex-col ${t.sender === 'user' ? 'items-end' : 'items-start'} group animate-in fade-in slide-in-from-bottom-4 duration-500`}>
                 <div className="flex items-center gap-2 mb-2">
                    {t.sender === 'ai' && <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />}
                    <span className={`text-[9px] font-black uppercase tracking-widest ${t.sender === 'user' ? 'text-zinc-600' : 'text-indigo-400'}`}>
                      {t.sender === 'user' ? 'Student' : 'Sterling'}
                    </span>
                    {t.sender === 'user' && <div className="w-1.5 h-1.5 rounded-full bg-zinc-600" />}
                 </div>
                 <div className={`p-4 rounded-2xl text-sm leading-relaxed max-w-[85%] border shadow-sm transition-all group-hover:shadow-indigo-500/5 ${
                   t.sender === 'user' 
                     ? 'bg-zinc-900 border-zinc-800 text-zinc-300 rounded-tr-sm' 
                     : 'bg-indigo-950/20 border-indigo-500/20 text-zinc-100 rounded-tl-sm'
                 }`}>
                    {t.text}
                 </div>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>

          {/* SESSION CONTROL */}
          <div className="p-6 border-t border-zinc-800/50 bg-zinc-950/50">
             {isActive ? (
               <button 
                 onClick={stopSession}
                 className="w-full py-4 rounded-2xl bg-zinc-900 hover:bg-red-950/30 border border-zinc-800 hover:border-red-900/50 text-zinc-400 hover:text-red-400 font-bold text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-3"
               >
                 <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                 Terminate Session
               </button>
             ) : (
                <div className="text-center">
                  <p className="text-[10px] text-zinc-600 font-medium uppercase tracking-widest">System Offline</p>
                </div>
             )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;