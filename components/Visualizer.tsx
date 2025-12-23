import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  audioContext: AudioContext | null;
  gainNode: GainNode | null;
  color?: string;
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive, audioContext, gainNode, color = '#3b82f6' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!isActive || !audioContext || !gainNode || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 64; // Low FFT size for chunky bars
    gainNode.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Calculate bar dimensions based on canvas size
      const barWidth = (canvas.width / bufferLength) * 0.6;
      const gap = (canvas.width / bufferLength) * 0.4;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        // Scale bar height to fit canvas vertically
        const barHeight = (dataArray[i] / 255) * canvas.height;

        ctx.fillStyle = color;
        
        // Use standard fillRect to avoid compatibility issues with roundRect
        // Draw bars from middle outwards or bottom up? Let's do bottom up.
        // Centering the bars looks cooler for voice
        const centerY = canvas.height / 2;
        ctx.fillRect(x, centerY - barHeight / 2, barWidth, barHeight);

        x += barWidth + gap;
      }
    };

    draw();

    return () => {
      if (animationRef.current !== undefined) cancelAnimationFrame(animationRef.current);
      // Clean up connections if possible, though mostly handled by React unmount
      try { analyser.disconnect(); } catch (e) {}
    };
  }, [isActive, audioContext, gainNode, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={300} 
      height={60} 
      className="w-full h-12 opacity-90"
    />
  );
};

export default Visualizer;