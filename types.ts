
export interface Transcription {
  text: string;
  sender: 'user' | 'ai';
  timestamp: number;
}

export interface VoiceTutorState {
  isActive: boolean;
  isMuted: boolean;
  isProcessing: boolean;
  transcriptions: Transcription[];
}

export enum PrebuiltVoice {
  Puck = 'Puck',
  Charon = 'Charon',
  Kore = 'Kore',
  Fenrir = 'Fenrir',
  Zephyr = 'Zephyr'
}
