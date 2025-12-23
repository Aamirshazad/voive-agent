
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
      
      // Initialize Video Stream if requested, but don't fail if only audio works
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
                <span className="bg-slate-700 text-slate-300 text-[9px] px-2 py-0.5 rounded-full border border-slate-600">Vision Enabled</span>
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
                    className="appearance-none bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600 hover:border-slate-500 text-xs rounded-lg focus:ring-teal-500 focus:border-teal-500 block w-28 p-2.5 pr-8 cursor-pointer transition-all outline-none uppercase font-semibold"
                  >
                    {Object.values(PrebuiltVoice).map((voice) => (
                      <option key={voice} value={voice}>{voice}</option>
                    ))}
                  </select>
                </div>

                {/* Strictness Toggle */}
                <button 
                  onClick={() => setStrictMode(!strictMode)}
                  className={`px-3 py-2 text-xs font-semibold uppercase rounded-lg border transition-all ${
                    strictMode 
                      ? 'bg-red-900/30 border-red-500/50 text-red-400' 
                      : 'bg-emerald-900/30 border-emerald-500/50 text-emerald-400'
                  }`}
                  title={strictMode ? "Strict Mode: Intense corrections" : "Casual Mode: Relaxed conversation"}
                >
                  {strictMode ? 'Strict' : 'Casual'}
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
