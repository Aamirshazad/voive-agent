
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  audioContext: AudioContext | null;
  gainNode: GainNode | null;
  color?: string;
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive, audioContext, gainNode, color = '#3b82f6' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Add initial value 'undefined' to useRef to satisfy TypeScript "Expected 1 arguments" requirement
  const animationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!isActive || !audioContext || !gainNode || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    gainNode.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = (dataArray[i] / 255) * canvas.height;

        ctx.fillStyle = color;
        // Rounded bars
        ctx.beginPath();
        ctx.roundRect(x, canvas.height - barHeight, barWidth - 1, barHeight, 4);
        ctx.fill();

        x += barWidth + 1;
      }
    };

    draw();

    return () => {
      if (animationRef.current !== undefined) cancelAnimationFrame(animationRef.current);
      analyser.disconnect();
    };
  }, [isActive, audioContext, gainNode, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={300} 
      height={100} 
      className="w-full h-16 opacity-80"
    />
  );
};

export default Visualizer;
