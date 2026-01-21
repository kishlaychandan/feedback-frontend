import React, { useState, useRef, useEffect } from 'react';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://lttalk.livingthings.dev';

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

  // Initialize Web Speech API (browser-based transcription)
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      // Live dictation: keep updating the input box while user speaks
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = 'en-US';

      recognitionRef.current.onresult = (event) => {
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const chunk = event.results[i][0]?.transcript || '';
          if (event.results[i].isFinal) {
            finalTranscriptRef.current = `${finalTranscriptRef.current} ${chunk}`.trim();
          } else {
            interimTranscript += chunk;
          }
        }

        const combined = `${finalTranscriptRef.current} ${interimTranscript}`.trim();
        if (combined.length > 0) setInputValue(combined);
        setSpeechError('');
      };

      recognitionRef.current.onerror = async (event) => {
        console.error('Speech recognition error:', event.error);
        const err = event?.error || 'unknown';
        
        setIsListening(false);
        if (err === 'network') {
          setSpeechError('Network error. Please check your internet connection and try again.');
        } else if (err === 'not-allowed' || err === 'service-not-allowed') {
          setSpeechError('Please give your browser microphone permission to use voice input.');
        } else if (err === 'no-speech') {
          setSpeechError('No speech detected. Please try again and speak clearly.');
        } else {
          setSpeechError(`Voice recognition error: ${err}. Please try again or type your message.`);
        }
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);

        // Send only when the user explicitly stopped the mic (mic click again / Stop button)
        if (shouldSendOnStopRef.current) {
          shouldSendOnStopRef.current = false;

          const textToSend =
            (finalTranscriptRef.current && finalTranscriptRef.current.trim()) ||
            (inputValueRef.current && inputValueRef.current.trim()) ||
            '';

          finalTranscriptRef.current = '';
          setInputValue('');

          if (textToSend) {
            // Auto-send and clear input (handleSendMessage already clears input on successful send)
            if (typeof sendMessageRef.current === 'function') {
              sendMessageRef.current(textToSend);
            }
          }
        }
      };
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  const handleVoiceInput = () => {
    if (!recognitionRef.current) {
      setSpeechError('Speech recognition is not supported in your browser. Please use text input.');
      return;
    }

    if (isListening) {
      // Stop listening -> auto-send when stopped
      shouldSendOnStopRef.current = true;
      recognitionRef.current.stop();
    } else {
      // Start listening
      setSpeechError('');
      finalTranscriptRef.current = '';
      shouldSendOnStopRef.current = false;
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const handleCancelListening = () => {
    if (!recognitionRef.current) return;
    // Stop without sending
    shouldSendOnStopRef.current = false;
    finalTranscriptRef.current = '';
    setInputValue('');
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

      if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(data.response);
        utterance.rate = 0.9;
        utterance.pitch = 1;
        window.speechSynthesis.speak(utterance);
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
            <h1>Living Things Cooling Management</h1>
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
          <h1>Living Things Cooling Management</h1>
          <p>Feedback Assistant</p>
          <div className="ac-selector-container">
            <span className="ac-selector-label">Zone:</span>
            <span className="ac-selector" style={{ cursor: 'default' }}>
              {zoneIdFromUrl || selectedAcId}
            </span>
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
          <div className="messages-container">
          {/* Center overlay while listening (over messages only, so input stays visible) */}
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
                        Stop &amp; Send
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

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
            >
              🎤
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

