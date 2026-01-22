/**
 * Microphone Permission Utility
 * Handles requesting and checking microphone permissions
 */

/**
 * Request microphone permission from the browser
 * @returns {Promise<boolean>} true if permission granted, false otherwise
 */
export async function requestMicrophonePermission() {
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop the stream immediately - we just needed permission
      stream.getTracks().forEach(track => track.stop());
      return true;
    }
    return false;
  } catch (err) {
    console.log('Microphone permission request failed:', err.name);
    return false;
  }
}

/**
 * Check if microphone permission is available
 * @returns {Promise<boolean>} true if permission is available, false otherwise
 */
export async function checkMicrophonePermission() {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const result = await navigator.permissions.query({ name: 'microphone' });
      return result.state === 'granted';
    }
    // Fallback: try to request permission
    return await requestMicrophonePermission();
  } catch (err) {
    console.log('Microphone permission check failed:', err);
    return false;
  }
}

/**
 * Get user-friendly error message for microphone permission
 * @param {string} errorType - The error type (e.g., 'not-allowed', 'NotAllowedError')
 * @returns {string} User-friendly error message
 */
export function getMicrophonePermissionErrorMessage(errorType) {
  if (errorType === 'not-allowed' || errorType === 'service-not-allowed' || errorType === 'NotAllowedError') {
    return 'Microphone permission is required. Please enable microphone access in your browser settings and try again. On mobile: Settings > Browser > Microphone > Allow';
  }
  return 'Microphone permission error. Please try again.';
}

