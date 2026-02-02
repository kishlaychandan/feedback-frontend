import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import { requestMicrophonePermission, getMicrophonePermissionErrorMessage } from './utils/microphonePermission';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';
// const API_URL = process.env.REACT_APP_API_URL || 'https://lttalk.livingthings.dev';

/**
 * Map zone ID to friendly display name
 */
function getZoneDisplayName(zoneId) {
  if (!zoneId) return zoneId;
  const zoneMap = {
    '1': 'Zone 1',
    '2': 'Zone 2',
    '3': 'Conference Room',
    'AC-001': 'AC-001',
    'AC-002': 'AC-002',
    'AC-003': 'AC-003',
  };
  return zoneMap[String(zoneId)] || zoneId;
}

/**
 * Detect if running on iOS Safari
 * iOS Safari has restrictions on speech synthesis that require user interaction
 */
function isIOSSafari() {
  const ua = window.navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const webkit = /WebKit/.test(ua);
  const chrome = /CriOS|FxiOS/.test(ua); // Chrome/Firefox on iOS
  return iOS && webkit && !chrome; // iOS Safari (not Chrome/Firefox on iOS)
}

function App() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [speechError, setSpeechError] = useState('');
  const [selectedAcId, setSelectedAcId] = useState('AC-001'); // Fallback only (dropdown removed)
  const [zoneIdFromUrl, setZoneIdFromUrl] = useState(''); // If present, prefer this over dropdown
  const [isZoneContext, setIsZoneContext] = useState(false); // true only when opened via QR/id URL
  const messagesEndRef = useRef(null);
  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef('');
  const shouldSendOnStopRef = useRef(false);
  const inputValueRef = useRef('');
  const sendMessageRef = useRef(null);
  const messagesRef = useRef([]);
  const selectedAcIdRef = useRef('AC-001');
  const isLoadingRef = useRef(false);
  const sessionIdRef = useRef('');

  // Create a stable per-browser sessionId for multi-user concurrency (demo)
  useEffect(() => {
    try {
      const key = 'lt_feedback_session_id';
      const existing = window.localStorage.getItem(key);
      if (existing && existing.trim()) {
        sessionIdRef.current = existing.trim();
        return;
      }
      const newId =
        (window.crypto && typeof window.crypto.randomUUID === 'function'
          ? window.crypto.randomUUID()
          : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
      window.localStorage.setItem(key, newId);
      sessionIdRef.current = newId;
    } catch {
      // If storage is blocked, fallback to a non-persistent id
      sessionIdRef.current = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
  }, []);

  // Read zoneId from QR URL like: https://your-app/?zoneId=ZONE_123
  useEffect(() => {
    try {
      // Support both:
      // 1) /?zoneId=ZONE_123
      // 2) /ZONE_123  (path-based)
      const params = new URLSearchParams(window.location.search);
      const zidFromQuery = (params.get('zoneId') || '').trim();

      const path = (window.location.pathname || '/').trim();
      const isRoot = path === '/' || path === '';
      const zidFromPath = !isRoot ? path.replace(/^\/+/, '').split('/')[0].trim() : '';

      const zid = (zidFromQuery || zidFromPath || '').trim();
      if (!zid) {
        setIsZoneContext(false);
        return;
      }

      const cleaned = zid.slice(0, 64);
      setZoneIdFromUrl(cleaned);
      setIsZoneContext(true);
      // Keep fallback in sync (dropdown removed; still used as fallback if needed)
      setSelectedAcId(cleaned);
      setSpeechError('');
    } catch {
      // ignore
    }
  }, []);

  // Keep latest input in a ref (so speech callbacks don't need hook deps)
  useEffect(() => {
    inputValueRef.current = inputValue;
  }, [inputValue]);

  // Keep latest messages / selection / loading in refs (for stable callbacks)
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    selectedAcIdRef.current = selectedAcId;
  }, [selectedAcId]);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);
  
  // TODO: Replace with QR code scanner - scan QR to get AC ID
  // For now, using dropdown selection

  // Auto-scroll to bottom when new messages are added
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Request microphone permission on page load
  useEffect(() => {
    // Request permission after a short delay to avoid blocking page load
    const timer = setTimeout(() => {
      requestMicrophonePermission().then(granted => {
        if (granted) {
          console.log('Microphone permission granted on page load');
        } else {
          console.log('Microphone permission not granted yet - will request when user tries voice');
        }
      });
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  // Initialize Web Speech API (browser-based transcription)
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      // Live dictation: keep updating the input box while user speaks
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = 'en-US';
      
      // Mobile-specific: prevent auto-restart on mobile browsers
      // Some mobile browsers auto-restart recognition, causing duplicates
      recognitionRef.current.onstart = () => {
        // Only reset if this was a manual start (not auto-restart)
        if (recognitionRef.current._isManualStart) {
          finalTranscriptRef.current = '';
          recognitionRef.current._isManualStart = false;
          // Clear seen texts on manual start to allow fresh recognition
          if (recognitionRef.current._seenFinalTexts) {
            recognitionRef.current._seenFinalTexts.clear();
          }
        }
      };
      
      // Prevent auto-restart on mobile (which causes duplicate text)
      recognitionRef.current.onend = () => {
        setIsListening(false);
        if (recognitionRef.current) {
          recognitionRef.current._isManualStart = false; // Reset flag
        }

        // On mobile, recognition might end automatically (timeout, no speech, etc.)
        // Only auto-send if user explicitly clicked "Stop & Send" button
        if (shouldSendOnStopRef.current) {
          shouldSendOnStopRef.current = false;

          const textToSend =
            (finalTranscriptRef.current && finalTranscriptRef.current.trim()) ||
            (inputValueRef.current && inputValueRef.current.trim()) ||
            '';

          // Clear transcripts to prevent accumulation
          finalTranscriptRef.current = '';
          inputValueRef.current = '';
          setInputValue('');

          if (textToSend && textToSend.length > 0) {
            // Small delay to ensure state is updated
            setTimeout(() => {
              if (typeof sendMessageRef.current === 'function') {
                sendMessageRef.current(textToSend);
              }
            }, 100);
          }
        } else {
          // Recognition ended but user didn't request send
          // Keep the text in input so user can review/edit before sending manually
          // Only clear if there's no meaningful text
          const currentText = inputValueRef.current || '';
          if (currentText.trim().length === 0) {
            finalTranscriptRef.current = '';
            inputValueRef.current = '';
            setInputValue('');
          }
        }
      };

      recognitionRef.current.onresult = (event) => {
        // MOBILE-FIXED: Robust deduplication for mobile browser quirks
        // Mobile browsers can fire overlapping results, reset resultIndex, or include duplicates
        // Solution: Track ALL final results by exact text, rebuild transcript from scratch
        
        // Initialize tracking Set if needed
        if (!recognitionRef.current._seenFinalTexts) {
          recognitionRef.current._seenFinalTexts = new Set();
        }
        
        // Rebuild transcript from ALL results (mobile can reset resultIndex)
        // But only add each unique final text ONCE
        const finalTextParts = [];
        let interimText = '';
        
        // Process ALL results (mobile browsers can reset resultIndex, so we need to check all)
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const chunk = (result[0]?.transcript || '').trim();
          if (!chunk) continue;
          
          if (result.isFinal) {
            // For final results: track by exact text (case-insensitive) to prevent duplicates
            const chunkKey = chunk.toLowerCase();
            if (!recognitionRef.current._seenFinalTexts.has(chunkKey)) {
              recognitionRef.current._seenFinalTexts.add(chunkKey);
              finalTextParts.push(chunk);
            }
          } else {
            // Interim results: append (they're temporary and update frequently)
            interimText += (interimText ? ' ' : '') + chunk;
          }
        }
        
        // Rebuild final transcript from unique parts (in order)
        if (finalTextParts.length > 0) {
          finalTranscriptRef.current = finalTextParts.join(' ').trim();
        }
        
        // Combine final + interim for display - update immediately for lowest latency
        const combined = `${finalTranscriptRef.current} ${interimText}`.trim();
        
        // Update state immediately (no delays, no debouncing) for instant feedback
        if (combined.length > 0) {
          inputValueRef.current = combined;
          setInputValue(combined); // Immediate update for lowest latency
        }
        setSpeechError('');
      };

      recognitionRef.current.onerror = async (event) => {
        console.error('Speech recognition error:', event.error);
        const err = event?.error || 'unknown';
        
        setIsListening(false);
        if (recognitionRef.current) {
          recognitionRef.current._isManualStart = false; // Reset flag on error
        }
        // Never auto-send after an error
        shouldSendOnStopRef.current = false;
        
        if (err === 'network') {
          setSpeechError('Network error. Please check your internet connection and try again.');
        } else if (err === 'not-allowed' || err === 'service-not-allowed') {
          // Permission denied - request again
          setSpeechError('Microphone permission denied. Requesting permission again...');
          requestMicrophonePermission().then(result => {
            if (result.granted) {
              setSpeechError('Permission granted! Please click the microphone button again to use voice input.');
            } else if (result.permanentlyBlocked) {
              // Permanently blocked - show instructions to enable manually
              setSpeechError(getMicrophonePermissionErrorMessage(err, true));
            } else {
              // Temporary denial or other error
              setSpeechError(getMicrophonePermissionErrorMessage(err, false));
            }
          });
        } else if (err === 'no-speech') {
          setSpeechError('No speech detected. Please try again and speak clearly.');
        } else {
          setSpeechError(`Voice recognition error: ${err}. Please try again or type your message.`);
        }
      };
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  const handleVoiceInput = async () => {
    // If SpeechRecognition is not initialized, check if browser supports it and request permission
    if (!recognitionRef.current) {
      const isSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
      if (!isSupported) {
        // Detect browser and provide helpful message
        const userAgent = navigator.userAgent;
        let browserInfo = 'your browser';
        let suggestion = '';
        
        if (userAgent.indexOf('Firefox') > -1) {
          browserInfo = 'Firefox';
          suggestion = 'Voice input requires Chrome, Edge, or Safari. Please use one of these browsers or type your message instead.';
        } else if (userAgent.indexOf('Safari') > -1 && userAgent.indexOf('Chrome') === -1) {
          browserInfo = 'Safari';
          suggestion = 'Please use Chrome or Edge for voice input, or type your message instead.';
        } else {
          suggestion = 'Voice input requires Chrome, Edge, or Safari. Please use one of these browsers or type your message instead.';
        }
        
        setSpeechError(`Speech recognition is not supported in ${browserInfo}. ${suggestion}`);
        return;
      }
      
      // Browser supports it but recognition not initialized - likely permission issue
      // Request permission first
      setSpeechError('Requesting microphone permission...');
      const permissionGranted = await requestMicrophonePermission();
      
      if (!permissionGranted) {
        setSpeechError(getMicrophonePermissionErrorMessage('not-allowed'));
        return;
      }
      
      // Permission granted, but recognition still not initialized
      // This shouldn't happen, but show helpful message
      setSpeechError('Permission granted! Please refresh the page to enable voice input.');
      return;
    }

    if (isListening) {
      // User clicked mic again to stop -> auto-send when stopped
      shouldSendOnStopRef.current = true;
      recognitionRef.current.stop();
    } else {
      // Start listening - reset everything
      setSpeechError('');
      finalTranscriptRef.current = '';
      inputValueRef.current = '';
      setInputValue('');
      shouldSendOnStopRef.current = false;
      
      // Mark as manual start to reset transcript properly (prevents duplicate text on mobile)
      if (recognitionRef.current) {
        recognitionRef.current._isManualStart = true;
        // Clear seen texts to start fresh
        if (recognitionRef.current._seenFinalTexts) {
          recognitionRef.current._seenFinalTexts.clear();
        }
      }
      
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch (err) {
        // If already started or other error, just update state
        console.warn('Speech recognition start error:', err);
        setIsListening(false);
        // Check if it's a permission error
        if (err.name === 'NotAllowedError' || err.message?.includes('permission') || err.message?.includes('not-allowed')) {
          // Request permission again
          setSpeechError('Microphone permission denied. Requesting permission again...');
          const permissionGranted = await requestMicrophonePermission();
          if (permissionGranted) {
            setSpeechError('Permission granted! Please click the microphone button again to use voice input.');
          } else {
            setSpeechError(getMicrophonePermissionErrorMessage('not-allowed'));
          }
        } else {
          setSpeechError('Could not start voice recognition. Please try again or type your message.');
        }
        if (recognitionRef.current) {
          recognitionRef.current._isManualStart = false;
        }
      }
    }
  };

  const handleCancelListening = () => {
    if (!recognitionRef.current) return;
    // Stop without sending
    shouldSendOnStopRef.current = false;
    finalTranscriptRef.current = '';
    inputValueRef.current = '';
    setInputValue('');
    // Clear seen texts when canceling
    if (recognitionRef.current._seenFinalTexts) {
      recognitionRef.current._seenFinalTexts.clear();
    }
    recognitionRef.current.stop();
  };

  const handleSendMessage = async (overrideText) => {
    const raw = typeof overrideText === 'string' ? overrideText : inputValueRef.current;
    const message = (raw || '').trim();
    if (!message || isLoadingRef.current) return;

    const acId = selectedAcIdRef.current;
    if (!acId) {
      setSpeechError('Please select an AC ID before sending your message.');
      return;
    }

    const userMessage = { type: 'user', text: message, timestamp: new Date() };
    const nextMessages = [...(messagesRef.current || []), userMessage];

    // Keep state + ref in sync immediately (so history uses the same messages the UI will show)
    messagesRef.current = nextMessages;
    setMessages(nextMessages);

    setInputValue('');
    inputValueRef.current = '';

    setIsLoading(true);
    isLoadingRef.current = true;

    try {
      const historyWindow = nextMessages
        .slice(-10)
        .filter(m => m && typeof m.text === 'string' && m.text.trim().length > 0)
        .map(m => ({
          role: m.type === 'assistant' ? 'assistant' : 'user',
          text: String(m.text).slice(0, 500),
        }));

      const response = await fetch(`${API_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          zoneId: zoneIdFromUrl || acId, // QR zoneId preferred, fallback to dropdown
          acId: acId, // keep for backward compatibility
          sessionId: sessionIdRef.current,
          history: historyWindow,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to get response');
      }

      const data = await response.json();
      // If backend had to fallback due to Gemini limits/timeouts, show a prominent warning (but still show reply)
      if (data && data.llm && data.llm.ok === false) {
        setSpeechError(data.llm.message || 'Gemini is limited right now. Using fallback mode.');
      }
      const assistantMessage = {
        type: 'assistant',
        text: data.response,
        timestamp: new Date(),
      };

      messagesRef.current = [...messagesRef.current, assistantMessage];
      setMessages(messagesRef.current);

      // Auto-speak on non-iOS browsers (Android Chrome, desktop browsers)
      // iOS Safari requires user interaction, so we'll show a play button instead
      if ('speechSynthesis' in window && !isIOSSafari()) {
        try {
          window.speechSynthesis.cancel(); // Cancel any ongoing speech
          const utterance = new SpeechSynthesisUtterance(data.response);
          utterance.lang = 'hi-IN';
          window.speechSynthesis.speak(utterance);
        } catch (err) {
          console.warn('Speech synthesis error:', err);
        }
      }
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage = {
        type: 'error',
        text: `Error: ${error.message}`,
        timestamp: new Date(),
      };
      messagesRef.current = [...messagesRef.current, errorMessage];
      setMessages(messagesRef.current);
    } finally {
      setIsLoading(false);
      isLoadingRef.current = false;
    }
  };

  // Keep ref pointer up-to-date for speech callbacks
  sendMessageRef.current = handleSendMessage;

  return (
    <div className="App">
      <div className="chat-container">
        {!isZoneContext ? (
          <div className="chat-header">
            <div className="header-content">
              <img src="/living_things.svg" alt="Ling Bot" className="header-logo" />
              <h1>LIVING BOT</h1>
            </div>
            <p>Dashboard</p>
            <div className="welcome-message" style={{ marginTop: 16 }}>
              <p>
                Scan the QR on the AC/room to open the Feedback Assistant.
              </p>
              <p style={{ marginTop: 10, color: '#666' }}>
                Example URL: <strong>/AC-001</strong> or <strong>/?zoneId=AC-001</strong>
              </p>
            </div>
          </div>
        ) : (
        <div className="chat-header">
          <div className="header-layout">
            {/* Left: Logo */}
            <div className="header-left">
              <img src="/living_things.svg" alt="Ling Bot" className="header-logo" />
            </div>
            
            {/* Middle: Title, Feedback Assistant, Working Area */}
            <div className="header-middle">
              <h1>LIVING THINGS</h1>
              {/* <p>Feedback Assistant</p> */}
              <div className="working-area-container">
                {/* <span className="ac-selector-label">Working Area:</span> */}
                <span className="ac-selector" style={{ cursor: 'default' }}>
                  {getZoneDisplayName(zoneIdFromUrl || selectedAcId)}
                </span>
              </div>
            </div>
            
            {/* Right: Refresh Button */}
            <div className="header-right">
              <button
                onClick={() => {
                  // Hard refresh: bypass cache by adding timestamp to URL
                  const url = new URL(window.location.href);
                  url.searchParams.set('_refresh', Date.now().toString());
                  window.location.href = url.toString();
                }}
                className="refresh-button"
                title="Hard refresh (bypass cache)"
                type="button"
                style={{
                  background: 'rgba(255, 255, 255, 0.2)',
                  border: '1px solid rgba(255, 255, 255, 0.4)',
                  borderRadius: '8px',
                  color: 'white',
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: '500',
                  transition: 'all 0.3s',
                  flexShrink: 0
                }}
                onMouseEnter={(e) => {
                  e.target.style.background = 'rgba(255, 255, 255, 0.3)';
                  e.target.style.borderColor = 'rgba(255, 255, 255, 0.6)';
                }}
                onMouseLeave={(e) => {
                  e.target.style.background = 'rgba(255, 255, 255, 0.2)';
                  e.target.style.borderColor = 'rgba(255, 255, 255, 0.4)';
                }}
              >
                Refresh
              </button>
            </div>
          </div>
          {speechError && (
            <div className="speech-error" role="alert">
              {speechError}
            </div>
          )}
        </div>

        )}

        {!isZoneContext ? null : (
          <>
          <div className="messages-wrapper">
          {/* Listening overlay outside scroll area so it stays centered on screen when chat is long */}
          {isListening && (
            <div className="listening-overlay" role="dialog" aria-live="polite">
              <div className="listening-card">
                <div className="listening-content">
                  <div className="listening-animation" aria-hidden="true">
                    <span className="pulse-dot"></span>
                    <span className="pulse-ring"></span>
                  </div>
                  <div className="listening-text">
                    <p className="listening-title">🎤 Listening…</p>
                    <p className="listening-hint">Speak normally — live text is updating below.</p>

                    <div className="listening-transcript" aria-label="Live transcription">
                      {inputValue && inputValue.trim().length > 0 ? inputValue : '…'}
                    </div>

                    <div className="listening-actions">
                      <button
                        className="cancel-listening-btn secondary"
                        onClick={handleCancelListening}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="cancel-listening-btn"
                        onClick={handleVoiceInput}
                        type="button"
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="messages-container">
          {messages.length === 0 && !isListening ? (
            <div className="welcome-message">
              <p>👋 Welcome! You can:</p>
              <ul>
                <li>Type your feedback in the text box below</li>
                <li>Click the microphone icon for voice input</li>
                <li>Share concerns like "I'm feeling cold" or "I'm not feeling well"</li>
              </ul>
            </div>
          ) : (
            messages.map((msg, index) => (
              <div key={index} className={`message ${msg.type}`}>
                <div className="message-content">
                  <p>{msg.text}</p>
                  <span className="message-time">
                    {msg.timestamp.toLocaleTimeString()}
                  </span>
                  {/* Play button for assistant messages (especially useful for iOS Safari) */}
                  {msg.type === 'assistant' && 'speechSynthesis' in window && (
                    <button
                      className="play-speech-button"
                      onClick={() => {
                        try {
                          window.speechSynthesis.cancel();
                          const utterance = new SpeechSynthesisUtterance(msg.text);
                          utterance.lang = 'hi-IN';
                          window.speechSynthesis.speak(utterance);
                        } catch (err) {
                          console.warn('Failed to speak:', err);
                        }
                      }}
                      title="Play response"
                      type="button"
                      aria-label="Play response audio"
                    >
                      🔊
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
          {isLoading && !isListening && (
            <div className="message assistant">
              <div className="message-content">
                <div className="typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        </div>

        <div className="input-container">
          <div className="input-wrapper">
            <textarea
              className="text-input"
              placeholder={isListening ? "Listening... Speak your feedback" : "Type your feedback here..."}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              rows="1"
              disabled={isLoading}
            />
            <button
              className={`voice-button ${isListening ? 'listening' : ''}`}
              onClick={handleVoiceInput}
              disabled={isLoading}
              title={isListening ? 'Stop listening' : 'Start voice input'}
              aria-label={isListening ? 'Stop listening' : 'Start voice input'}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="mic-icon"
              >
                <path
                  d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"
                  fill="currentColor"
                />
                <path
                  d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"
                  fill="currentColor"
                />
              </svg>
            </button>
            <button
              className="send-button"
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || isLoading}
              title="Confirm (✓) and send"
            >
              {isLoading ? '⏳' : '✓'}
            </button>
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;

