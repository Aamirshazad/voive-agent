import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Transcription, PrebuiltVoice } from './types';
import { decode, decodeAudioData, createPcmBlob } from './utils/audioUtils';
import Visualizer from './components/Visualizer';

const getSystemInstruction = (strictMode: boolean) => `
You are "Professor Sterling", a distinguished, expert English Instructor (ESL & Linguistics Specialist). 
You are NOT a passive assistant; you are a **TEACHER**. Take charge of the learning environment.

**VISION CAPABILITY:**
You have access to the student's video feed. 
1. If the student shows you an object, describe it, name it in English, and ask them to repeat the word.
2. If the student is looking at the camera, you can engage with their facial expressions (e.g., "You look confused, let me explain that again").
3. Use visual cues to facilitate the lesson.

**YOUR OBJECTIVE:**
Conduct a professional, interactive English lesson tailored to the student's specific goals. You offer four distinct learning tracks:
1. **Language Fundamentals** (Teaching new vocabulary, phrasal verbs, idioms).
2. **Communication & Fluency** (Natural conversation practice, storytelling).
3. **Grammar Precision** (Strict syntax correction, tenses).
4. **Accent Reduction** (Standard American English Phonetics).

**CORRECTION STYLE (${strictMode ? 'STRICT' : 'CASUAL'}):**
${strictMode 
  ? 'You are in STRICT mode. Interrupt the student immediately for ANY pronunciation, grammar, or vocabulary error. Do not let small mistakes slide. Be rigorous.' 
  : 'You are in CASUAL mode. Prioritize conversation flow. Only correct major errors that impede understanding. Allow small grammar slips to keep the student confident.'
}

**ACCENT REDUCTION SPECIFICS:**
Focus on General American (GenAm) traits: Rhoticity (Hard R), Flap 'T', 'TH' Sounds, and Vowel Precision (/i/ vs /ɪ/).

**PHONETIC BREAKDOWN & TARGETED DRILLS:**
When the student mispronounces a complex word or struggles with specific sounds, initiate a **TARGETED DRILL**:

1.  **ISOLATE**: Stop the conversation politely. Explicitly identify the specific sound or syllable causing the issue (not just the whole word).
2.  **EXPLAIN (The "How")**:
    *   Provide the IPA transcription (e.g., "That word is /skɛdʒ.uːl/").
    *   **Mouth Mechanics**: Describe the physical action. 
        *   *Example*: "For /θ/, stick your tongue slightly between your teeth and blow air—don't bite your lip."
        *   *Example*: "For the American 'R', pull your tongue back like a spoon; do not touch the roof of your mouth."
3.  **EXECUTE DRILL SEQUENCE**:
    *   **Step A (The Sound)**: "Make just the sound with me: [Sound]... [Sound]... [Sound]."
    *   **Step B (The Word)**: "Now put it back into the word: [Word]."
    *   **Step C (Application)**: "Use that word in a short sentence for me."
4.  **VERIFY**: If they succeed, praise them specifically on the correction. If they fail twice, offer a simplified alternative and move on to maintain flow.

**SESSION FLOW:**
1.  **Greeting**: Introduce yourself. **IMMEDIATELY ask the student to choose their focus.**
2.  **The Lesson**: Engage in dialogue. If they have the camera on, ask them to show you something around them to practice vocabulary.
3.  **Feedback**: Provide immediate feedback based on the Strictness level.

**IMPORTANT**: You are the teacher. Do not just agree with the student. Guide them to mastery.
`;

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [strictMode, setStrictMode] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState<string>(PrebuiltVoice.Zephyr);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Audio Context Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputGainNodeRef = useRef<GainNode | null>(null);
  const outputGainNodeRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);

  // Video Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const videoIntervalRef = useRef<number | null>(null);

  // Live Session Ref
  const sessionRef = useRef<any>(null);
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcriptions]);

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close?.();
      sessionRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    
    // Stop Video
    if (videoIntervalRef.current) {
      window.clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(track => track.stop());
      videoStreamRef.current = null;
    }

    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    setIsActive(false);
    setIsCameraOn(false);
  }, []);

  // Helper to capture and send frames
  const startVideoTransmission = (session: any) => {
    if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);
    
    videoIntervalRef.current = window.setInterval(() => {
      if (!videoRef.current || !videoCanvasRef.current || !isCameraOn) return;
      
      const canvas = videoCanvasRef.current;
      const ctx = canvas.getContext('2d');
      const video = videoRef.current;

      if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
        // Draw video frame to canvas
        canvas.width = video.videoWidth * 0.5; // Downscale for bandwidth
        canvas.height = video.videoHeight * 0.5;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        const base64 = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
        
        session.sendRealtimeInput({ 
          media: { 
            mimeType: 'image/jpeg', 
            data: base64 
          } 
        });
      }
    }, 1000); // 1 FPS is sufficient for teaching objects
  };

  const startSession = async () => {
    try {
      setError(null);
      const ai = new GoogleGenAI({ 
        apiKey: process.env.API_KEY,
        httpOptions: { apiVersion: 'v1alpha' }
      });
      
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const inputGain = inputCtx.createGain();
      const outputGain = outputCtx.createGain();
      inputGainNodeRef.current = inputGain;
      outputGainNodeRef.current = outputGain;
      outputGain.connect(outputCtx.destination);

      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Initialize Video Stream if requested
      if (isCameraOn) {
         try {
           const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
           videoStreamRef.current = videoStream;
           if (videoRef.current) {
             videoRef.current.srcObject = videoStream;
             videoRef.current.play();
           }
         } catch (e) {
           console.warn("Camera failed to start", e);
           setIsCameraOn(false);
         }
      }

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            console.log('Classroom Session opened');
            setIsActive(true);
            
            // Start Audio Streaming
            const source = inputCtx.createMediaStreamSource(audioStream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (isMuted) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(inputGain);
            inputGain.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);

            // Start Video Streaming if active
            if (isCameraOn) {
               sessionPromise.then(session => startVideoTransmission(session));
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputGainNodeRef.current!);
              
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const userText = currentInputTranscription.current;
              const aiText = currentOutputTranscription.current;
              if (userText || aiText) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(userText ? [{ text: userText, sender: 'user' as const, timestamp: Date.now() }] : []),
                  ...(aiText ? [{ text: aiText, sender: 'ai' as const, timestamp: Date.now() }] : [])
                ]);
              }
              currentInputTranscription.current = '';
              currentOutputTranscription.current = '';
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => {
                try { s.stop(); } catch(e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (err) => {
            console.error('Session error:', err);
            setError('Connection failed. Please refresh.');
            stopSession();
          },
          onclose: () => {
            console.log('Session closed');
            setIsActive(false);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          // @ts-ignore
          enableAffectiveDialog: true,
          systemInstruction: getSystemInstruction(strictMode),
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Start session error:', err);
      setError('Microphone/Camera access denied or API connectivity issue.');
      setIsActive(false);
    }
  };

  const toggleMute = () => setIsMuted(!isMuted);
  
  const toggleCamera = async () => {
    if (!isActive) {
      setIsCameraOn(!isCameraOn);
      return;
    }

    // Logic for toggling mid-session
    if (isCameraOn) {
      // Turn off
      if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);
      if (videoStreamRef.current) videoStreamRef.current.getTracks().forEach(t => t.stop());
      setIsCameraOn(false);
    } else {
      // Turn on
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        videoStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
        setIsCameraOn(true);
        if (sessionRef.current) {
          startVideoTransmission(sessionRef.current);
        }
      } catch (e) {
        console.error("Could not start camera mid-session", e);
      }
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center bg-slate-900 overflow-hidden font-sans">
      <header className="w-full bg-slate-800 border-b border-slate-700 shadow-md z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-teal-600 rounded-lg flex items-center justify-center shadow-lg shadow-teal-900/50">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            </div>
            <div>
              <h1 className="text-xl font-semibold text-slate-100 tracking-tight">Prof. Sterling</h1>
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-teal-400 uppercase tracking-widest">AI English Instructor</p>
                <span className={`bg-slate-700 text-slate-300 text-[9px] px-2 py-0.5 rounded-full border border-slate-600 flex items-center gap-1 ${isCameraOn ? 'text-teal-400 border-teal-500' : ''}`}>
                  {isCameraOn ? (
                     <>
                      <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse"></span>
                      Vision Active
                     </>
                  ) : 'Audio Only'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {!isActive && (
              <div className="flex items-center gap-2">
                {/* Voice Selector */}
                <div className="relative group">
                   <select
                    value={selectedVoice}
                    onChange={(e) => setSelectedVoice(e.target.value)}
                    className="appearance-none bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600 hover:border-slate-500 text-xs rounded-lg focus:ring-teal-500 focus:border-teal-500 block w-24 p-2.5 pr-6 cursor-pointer transition-all outline-none uppercase font-semibold tracking-wide"
                  >
                    {Object.values(PrebuiltVoice).map((voice) => (
                      <option key={voice} value={voice}>{voice}</option>
                    ))}
                  </select>
                </div>

                {/* Strictness Toggle */}
                <button 
                  onClick={() => setStrictMode(!strictMode)}
                  className={`px-3 py-2 text-xs font-bold uppercase tracking-wider rounded-lg border transition-all ${
                    strictMode 
                      ? 'bg-red-900/40 border-red-500 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.2)]' 
                      : 'bg-emerald-900/40 border-emerald-500 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                  }`}
                  title={strictMode ? "Strict Mode: Intense corrections" : "Casual Mode: Relaxed conversation"}
                >
                  {strictMode ? 'Strict' : 'Casual'}
                </button>

                 {/* Camera Toggle (Pre-session) */}
                 <button 
                  onClick={toggleCamera}
                  className={`p-2.5 rounded-lg border transition-all ${
                    isCameraOn 
                      ? 'bg-indigo-600 text-white border-indigo-500' 
                      : 'bg-slate-700 text-slate-400 border-slate-600 hover:text-white'
                  }`}
                  title="Toggle Camera"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                </button>
              </div>
            )}
            
            {isActive ? (
               <button 
                onClick={stopSession}
                className="px-5 py-2.5 bg-red-900/30 text-red-400 border border-red-800/50 font-medium rounded-lg hover:bg-red-900/50 transition-all flex items-center gap-2 text-sm"
              >
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]"></span>
                Dismiss Class
              </button>
            ) : (
              <button 
                onClick={startSession}
                className="px-6 py-2.5 bg-teal-600 text-white font-medium rounded-lg hover:bg-teal-500 transition-all shadow-lg shadow-teal-900/20 active:translate-y-0.5 flex items-center gap-2 text-sm"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>
                Begin Lesson
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl px-4 md:px-6 py-8 flex flex-col gap-6 h-full overflow-hidden">
        
        {/* Interaction Area */}
        <section className="bg-slate-800 rounded-2xl p-6 md:p-8 shadow-xl border border-slate-700 flex flex-col items-center justify-center relative min-h-[350px]">
          {error && (
            <div className="absolute top-4 z-20 bg-red-900/90 border border-red-700 text-red-200 px-6 py-3 rounded-lg text-sm flex items-center gap-2 backdrop-blur-sm">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          {/* Hidden Canvas for processing frames */}
          <canvas ref={videoCanvasRef} className="hidden" />

          {!isActive && !error && (
             <div className="text-center max-w-lg">
                <div className="w-20 h-20 bg-slate-700 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-slate-600 rotate-3 hover:rotate-0 transition-transform duration-500">
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-10 h-10 text-teal-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                </div>
                <h2 className="text-3xl font-light text-white mb-3">English Proficiency Studio</h2>
                <p className="text-slate-400 text-lg leading-relaxed mb-6">
                  Practice pronunciation, grammar, and fluency with an AI instructor who sees, listens, and corrects.
                </p>
                
                <div className="flex flex-wrap justify-center gap-3 text-slate-500 text-sm">
                   <div className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 rounded-full border border-slate-700">
                      <span className="w-2 h-2 rounded-full bg-teal-500"></span>
                      <span>Voice: <span className="text-teal-400 font-medium">{selectedVoice}</span></span>
                   </div>
                   <div className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 rounded-full border border-slate-700">
                      <span className={`w-2 h-2 rounded-full ${strictMode ? 'bg-red-500' : 'bg-emerald-500'}`}></span>
                      <span>Mode: <span className={`${strictMode ? 'text-red-400' : 'text-emerald-400'} font-medium`}>{strictMode ? 'Strict' : 'Casual'}</span></span>
                   </div>
                   {isCameraOn && (
                     <div className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 rounded-full border border-slate-700">
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                        <span className="text-indigo-400 font-medium">Vision Ready</span>
                     </div>
                   )}
                </div>
             </div>
          )}

          {isActive && (
            <div className="w-full h-full flex flex-col md:flex-row gap-6 animate-in fade-in duration-700">
              
              {/* Professor Side */}
              <div className="flex-1 flex flex-col items-center justify-center">
                <div className="relative mb-6">
                  <div className={`w-32 h-32 rounded-full p-1 bg-gradient-to-tr from-teal-500 to-slate-600 ${isMuted ? 'grayscale opacity-70' : ''}`}>
                    <div className="w-full h-full rounded-full bg-slate-800 p-1">
                      <img src="https://api.dicebear.com/7.x/personas/svg?seed=Professor&backgroundColor=e2e8f0" className="w-full h-full rounded-full object-cover bg-slate-200" alt="Prof Sterling" />
                    </div>
                  </div>
                </div>

                <div className="w-full bg-slate-900/50 border border-slate-700 p-4 rounded-xl flex flex-col items-center shadow-inner">
                  <span className="text-[10px] font-bold text-teal-500 uppercase mb-2 tracking-widest">Instructor Audio</span>
                  <Visualizer 
                    isActive={isActive} 
                    audioContext={outputAudioContextRef.current} 
                    gainNode={outputGainNodeRef.current}
                    color="#14b8a6" 
                  />
                </div>
              </div>

              {/* Student Side */}
              <div className="flex-1 flex flex-col items-center justify-center">
                <div className="relative mb-6 w-full max-w-[240px] aspect-video bg-black rounded-lg overflow-hidden border border-slate-600 shadow-lg">
                  {/* Video Element */}
                  <video 
                    ref={videoRef} 
                    className={`w-full h-full object-cover ${isCameraOn ? 'opacity-100' : 'opacity-0'}`} 
                    muted 
                    playsInline 
                    autoPlay 
                  />
                  {!isCameraOn && (
                    <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    </div>
                  )}
                  <div className="absolute bottom-2 right-2 flex gap-1">
                    <button 
                      onClick={toggleCamera}
                      className="p-1.5 bg-slate-900/80 text-white rounded-md hover:bg-slate-800"
                    >
                       {isCameraOn ? (
                         <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21l-3.5-3.5m-2-2l-2-2m-2-2l-2-2m-2-2l-3.5-3.5"/><path d="M1 1l22 22"/></svg>
                       ) : (
                         <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                       )}
                    </button>
                    <button 
                      onClick={toggleMute}
                      className={`p-1.5 rounded-md ${isMuted ? 'bg-red-500/80 text-white' : 'bg-slate-900/80 text-white hover:bg-slate-800'}`}
                    >
                      {isMuted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
                      )}
                    </button>
                  </div>
                </div>

                <div className="w-full bg-slate-900/50 border border-slate-700 p-4 rounded-xl flex flex-col items-center shadow-inner">
                  <span className="text-[10px] font-bold text-slate-400 uppercase mb-2 tracking-widest">Student Audio</span>
                  <Visualizer 
                    isActive={isActive && !isMuted} 
                    audioContext={inputAudioContextRef.current} 
                    gainNode={inputGainNodeRef.current}
                    color="#94a3b8"
                  />
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Transcripts / Chalkboard Section */}
        <section className="flex-1 bg-slate-800 rounded-2xl p-1 shadow-xl border border-slate-700 flex flex-col overflow-hidden min-h-[300px]">
          <div className="bg-slate-900/50 px-6 py-4 border-b border-slate-700 flex justify-between items-center rounded-t-xl">
            <h3 className="font-medium text-slate-200 flex items-center gap-2.5 text-sm tracking-wide">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-teal-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              Lesson Transcript & Corrections
            </h3>
            {transcriptions.length > 0 && (
              <button onClick={() => setTranscriptions([])} className="text-xs font-semibold text-slate-500 hover:text-slate-300 transition-colors uppercase tracking-wider">Clear Board</button>
            )}
          </div>
          
          <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-6 p-6 custom-scrollbar bg-slate-800">
            {transcriptions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-3">
                <span className="text-sm font-light italic">Waiting for conversation to begin...</span>
              </div>
            ) : (
              transcriptions.map((t, i) => (
                <div key={i} className={`flex flex-col ${t.sender === 'user' ? 'items-end' : 'items-start'}`}>
                  <div className={`flex items-center gap-2 mb-1.5 ${t.sender === 'user' ? 'flex-row-reverse' : ''}`}>
                    <span className={`text-[10px] font-bold uppercase tracking-widest ${t.sender === 'user' ? 'text-slate-400' : 'text-teal-400'}`}>
                      {t.sender === 'user' ? 'Student' : 'Professor'}
                    </span>
                  </div>
                  
                  <div className={`max-w-[85%] px-5 py-3.5 text-[15px] leading-relaxed shadow-sm backdrop-blur-sm ${
                    t.sender === 'user' 
                      ? 'bg-slate-700/50 text-slate-200 rounded-2xl rounded-tr-sm border border-slate-600' 
                      : 'bg-teal-900/20 text-teal-50 rounded-2xl rounded-tl-sm border border-teal-800/30'
                  }`}>
                    {t.text}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      <footer className="w-full py-5 text-center text-slate-600 text-[10px] font-medium uppercase tracking-[0.2em] border-t border-slate-800">
        Prof. Sterling AI System &bull; Powered by Google Gemini Native Audio
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #1e293b;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #334155;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #475569;
        }
      `}</style>
    </div>
  );
};

export default App;