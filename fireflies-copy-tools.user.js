// ==UserScript==
// @name         Fireflies Copy Transcript & Share Link
// @namespace    https://github.com/Elevate-Code
// @version      1.0.0
// @description  Adds a "Copy Transcript" button to Fireflies.ai, allowing one-click copying of the full transcript in a clean, readable format.
// @author       Elevate Code (Dimitri Sudomoin)
// @match        https://app.fireflies.ai/*
// @homepageURL  https://github.com/Elevate-Code/fireflies-copy-tools-userscript
// @supportURL   https://github.com/Elevate-Code/fireflies-copy-tools-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/Elevate-Code/fireflies-copy-tools-userscript/main/fireflies-copy-tools.user.js
// @updateURL    https://raw.githubusercontent.com/Elevate-Code/fireflies-copy-tools-userscript/main/fireflies-copy-tools.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// ==/UserScript==

/**
 * @file fireflies-copy-transcript.js
 * @description Userscript to add a one-click "Copy Transcript" button to Fireflies.ai.
 *              Handles SPA navigation by re-initializing on URL changes.
 *              Formatting and data fetching are based on original user specifications
 *              and API details from `fireflies_request.md`.
 *              Includes measures for resilience against SPA behavior.
 *
 * @intent
 * Provide a quick way to copy the Fireflies.ai meeting transcript in a user-defined,
 * readable format (speaker-segmented with timestamps) to the clipboard.
 *
 * @core_requirements_and_data
 * 1.  **UI**: Adds a "Copy Transcript" button to the media controls, styled like native buttons.
 * 2.  **Authentication**: Uses `AUTHORIZATION` and `REFRESH_TOKEN` from `localStorage` (keys
 *     sourced from `fireflies_request.md`) and `meetingNoteId` from the URL for API calls.
 * 3.  **Data Source**: Fetches `captions` (sentence, speaker_id, time) and `speakerMeta`
 *     (speaker_id to name mapping) via Fireflies' GraphQL API, as detailed in `fireflies_request.md`.
 * 4.  **Transcript Format (User-Specified)**:
 *     - Timestamp (MM:SS) and speaker name appear before each new speaker's dialogue.
 *     - Consecutive sentences from the same speaker are grouped.
 *     - Maps 0-indexed `captions[].speaker_id` to 1-indexed `speakerMeta` keys.
 * 5.  **Output**: Copies formatted transcript to clipboard; uses `alert()` for feedback.
 *
 * @key_external_dependencies
 * -   Assumes `AUTHORIZATION` and `REFRESH_TOKEN` are available in `localStorage` under those specific keys.
 * -   Relies on the stability of Fireflies.ai's GraphQL API structure (endpoint, query fields like
 *     `captions`, `speakerMeta`) and HTML/CSS for button placement, as initially documented.
 * -   Requires `GM_xmlhttpRequest` and `GM_setClipboard` grants.
 */

(function() {
    'use strict';

    const SCRIPT_ID_PREFIX = 'fireflies-copy-transcript-';
    const COPY_BUTTON_ID = `${SCRIPT_ID_PREFIX}copy-button`;
    const LOG_PREFIX = "FCT:"; // Fireflies Copy Transcript

    let currentWaitForButtonContainerTimer = null; // Holds the timer for waitForElement looking for the button's parent

    console.log(`${LOG_PREFIX} Script loaded (v0.8).`);

    // Function to wait for an element to appear in the DOM
    function waitForElement(selector, callback, timeout = 10000, interval = 100) {
        let elapsedTime = 0;
        const timerId = setInterval(function() {
            const element = document.querySelector(selector);
            if (element) {
                clearInterval(timerId);
                callback(element);
            } else {
                elapsedTime += interval;
                if (elapsedTime >= timeout) {
                    clearInterval(timerId);
                    console.warn(`${LOG_PREFIX} Element ${selector} not found after ${timeout / 1000} seconds.`);
                }
            }
        }, interval);
        return timerId; // Return the timer ID so it can be managed
    }

    function getAuthDetails() {
        const authToken = localStorage.getItem('AUTHORIZATION');
        const refreshToken = localStorage.getItem('REFRESH_TOKEN');
        if (!authToken || !refreshToken) {
            console.error(`${LOG_PREFIX} Auth or Refresh Token NOT Found in localStorage.`);
            alert("Fireflies Script: Auth tokens not found. Please ensure you are logged in and tokens are in localStorage.");
            return null;
        }
        console.log(`${LOG_PREFIX} Authorization and Refresh Tokens Found.`);
        return { authToken, refreshToken };
    }

    function getMeetingNoteIdFromUrl() {
        const urlParts = window.location.href.split('/');
        const viewSegment = urlParts.find(part => part.includes('::'));
        if (viewSegment) {
            const idParts = viewSegment.split('::');
            if (idParts.length > 1) {
                return idParts[1].split('?')[0];
            }
        }
        console.warn(`${LOG_PREFIX} Could not extract meetingNoteId from URL:`, window.location.href);
        return null;
    }

    function formatTime(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = Math.floor(totalSeconds % 60);
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function formatTranscript(meetingNote) {
        if (!meetingNote || !meetingNote.captions || !meetingNote.speakerMeta) {
            console.error(`${LOG_PREFIX} Invalid data provided to formatTranscript.`);
            return "Error: Could not format transcript due to missing data.";
        }

        const { captions, speakerMeta, title, date, attendees } = meetingNote;

        let header = "";
        if (title) {
            header = title;
            if (date) {
                header += ` | ${date}`;
            }
        }

        if (attendees && attendees.length > 0) {
            const attendeesList = attendees.map(attendee => {
                const name = attendee.displayName || attendee.name;
                const email = attendee.email;
                if (name && email) {
                    return `${name} ${email}`;
                } else if (name) {
                    return name;
                } else if (email) {
                    return email;
                }
                return null;
            }).filter(Boolean).join('\n');

            if (attendeesList) {
                if (header) {
                    header += `\n\n${attendeesList}`;
                } else {
                    header = attendeesList;
                }
            }
        }

        let body = "";
        let lastSpeakerId = null;
        let currentSpeakerTextAccumulator = "";

        for (const caption of captions) {
            const currentSpeakerId = caption.speaker_id;
            const speakerNameKey = (currentSpeakerId + 1).toString();
            const speakerName = speakerMeta[speakerNameKey] || `Unknown Speaker ${currentSpeakerId + 1}`;
            const timestamp = formatTime(caption.time);

            if (currentSpeakerId !== lastSpeakerId) {
                if (currentSpeakerTextAccumulator !== "") {
                    body += currentSpeakerTextAccumulator.trim() + "\n";
                }
                currentSpeakerTextAccumulator = "";

                if (body !== "") {
                    body += "\n";
                }
                body += `${timestamp}\n`;
                body += `${speakerName}\n`;
                lastSpeakerId = currentSpeakerId;
            }

            if (currentSpeakerTextAccumulator === "") {
                currentSpeakerTextAccumulator = caption.sentence;
            } else {
                currentSpeakerTextAccumulator += " " + caption.sentence;
            }
        }

        if (currentSpeakerTextAccumulator !== "") {
            body += currentSpeakerTextAccumulator.trim() + "\n";
        }

        if (header) {
            return `${header}\n\n${body.trim()}`.trim();
        } else {
            return body.trim();
        }
    }

    function fetchAndCopyTranscriptData(meetingNoteId, token, refreshTok) {
        if (!meetingNoteId) {
            console.error(`${LOG_PREFIX} Cannot fetch transcript without meetingNoteId.`);
            alert("Error: Could not determine Meeting ID.");
            return;
        }
        if (!token || !refreshTok) {
            console.error(`${LOG_PREFIX} Cannot fetch transcript without auth tokens.`);
            alert("Error: Auth tokens not found. Please ensure you are logged in.");
            return;
        }

        const graphqlQuery = {
            operationName: "fetchNotepadMeeting",
            variables: { meetingNoteId: meetingNoteId },
            query: "query fetchNotepadMeeting($meetingNoteId: String!) {\n  meetingNote(_id: $meetingNoteId) {\n    _id\n    captions {\n      index\n      sentence\n      speaker_id\n      time\n      endTime\n      __typename\n    }\n    attendees {\n      email\n      name\n      displayName\n      __typename\n    }\n    title\n    date\n    speakerMeta\n    __typename\n  }\n}"
        };

        console.log(`${LOG_PREFIX} Fetching transcript for meeting ID:`, meetingNoteId);

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://app.fireflies.ai/api/v4/graphql",
            headers: {
                "Content-Type": "application/json",
                "Accept": "*/*",
                "Authorization": `Bearer ${token}`,
                "X-Refresh-Token": refreshTok,
            },
            data: JSON.stringify(graphqlQuery),
            onload: function(response) {
                if (response.status >= 200 && response.status < 300) {
                    console.log(`${LOG_PREFIX} GraphQL Response Received:`, response.status);
                    try {
                        const parsedResponse = JSON.parse(response.responseText);
                        if (parsedResponse.data && parsedResponse.data.meetingNote) {
                            const formattedTranscript = formatTranscript(parsedResponse.data.meetingNote);
                            GM_setClipboard(formattedTranscript);
                            console.log(`${LOG_PREFIX} Formatted transcript copied to clipboard.`);
                            alert("Transcript copied to clipboard!");
                        } else {
                            console.error(`${LOG_PREFIX} meetingNote data not found in GraphQL response:`, parsedResponse);
                            alert("Error: Could not retrieve transcript data. Check console for details.");
                        }
                    } catch (e) {
                        console.error(`${LOG_PREFIX} Error parsing JSON response:`, e);
                        console.error(`${LOG_PREFIX} Raw response:`, response.responseText);
                        alert("Error: Could not parse transcript data. Check console for details.");
                    }
                } else {
                    console.error(`${LOG_PREFIX} GraphQL Request Failed. Status:`, response.status, response.statusText);
                    console.error(`${LOG_PREFIX} Response headers:`, response.responseHeaders);
                    console.error(`${LOG_PREFIX} Response text:`, response.responseText);
                    alert(`Error fetching transcript: ${response.status}. Check console for details.`);
                }
            },
            onerror: function(response) {
                console.error(`${LOG_PREFIX} GraphQL Request Error:`, response.statusText);
                console.error(`${LOG_PREFIX} Error details:`, response);
                alert("Network error while fetching transcript. Check console for details.");
            },
            ontimeout: function() {
                console.error(`${LOG_PREFIX} GraphQL Request Timed Out.`);
                alert("Request to fetch transcript timed out.");
            }
        });
    }

    function createCopyButton() {
        if (document.getElementById(COPY_BUTTON_ID)) {
            console.log(`${LOG_PREFIX} Copy Transcript button already exists.`);
            return;
        }

        // More robust selector targeting the download icon's specific SVG path.
        // This assumes the 'd' attribute for the download icon starts with this specific sequence.
        const downloadIconPathSelector = '#media_controls svg path[d^="M21 15V19C21 19.5304"]';

        // This assignment will be managed by initializeActiveViewFeatures, which clears previous timers.
        currentWaitForButtonContainerTimer = waitForElement(downloadIconPathSelector, function(downloadIconPathElement) {
            // downloadIconPathElement is the <path> element of the download icon.

            // Find the outer wrapper button of the native download button.
            // All control buttons (speed, play, download, reactions) share 'sc-c3c9f7eb-0 botkXK' as their outer pod class.
            // Could also do something like `button:nth-child(5)`
            const downloadButtonOuter = downloadIconPathElement.closest('button.sc-c3c9f7eb-0.botkXK');

            if (!downloadButtonOuter || !downloadButtonOuter.parentElement) {
                console.error(`${LOG_PREFIX} Could not find the native download button's wrapper or its parent using SVG path.`);
                return;
            }

            const outerButton = document.createElement('button');
            outerButton.id = COPY_BUTTON_ID; // Assign an ID for idempotency check
            outerButton.setAttribute('type', 'button');
            outerButton.setAttribute('data-state', 'closed');
            // Use the same class as other control button wrappers (e.g., native download button's outer element)
            outerButton.className = 'sc-c3c9f7eb-0 botkXK';

            const innerButton = document.createElement('button');
            // Ensure inner button classes match the native equivalent's inner button for consistent styling
            innerButton.className = 'sc-80373b0b-1 dOeQgS defaultNeutral sm single sc-db13e205-9 fGKSPn';
            innerButton.setAttribute('aria-label', 'Copy Transcript');
            innerButton.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
                  <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
                </svg>
            `;

            outerButton.appendChild(innerButton);

            outerButton.addEventListener('click', function() {
                console.log(`${LOG_PREFIX} Copy Transcript button clicked.`);
                const authDetails = getAuthDetails();
                const meetingNoteId = getMeetingNoteIdFromUrl();

                if (authDetails && meetingNoteId) {
                    fetchAndCopyTranscriptData(meetingNoteId, authDetails.authToken, authDetails.refreshToken);
                } else {
                    alert("Could not copy transcript. Missing Auth Tokens or Meeting ID. Check console.");
                    if (!meetingNoteId) console.error(`${LOG_PREFIX} Failed to get meetingNoteId for button click.`);
                    if (!authDetails) console.error(`${LOG_PREFIX} Failed to get authDetails for button click.`);
                }
            });

            // Insert the new button after the native download button.
            if (downloadButtonOuter.nextSibling) {
                downloadButtonOuter.parentElement.insertBefore(outerButton, downloadButtonOuter.nextSibling);
            } else {
                downloadButtonOuter.parentElement.appendChild(outerButton);
            }
            console.log(`${LOG_PREFIX} Copy Transcript button added to UI, positioned relative to the native download button.`);
        });
    }

    function initializeActiveViewFeatures() {
        console.log(`${LOG_PREFIX} Checking current view...`);

        // Always clear any pending waitForElement for the button container from a previous state/URL.
        // This prevents orphaned timers if navigation occurs while waiting for an element.
        if (currentWaitForButtonContainerTimer) {
            clearInterval(currentWaitForButtonContainerTimer);
            currentWaitForButtonContainerTimer = null;
            console.log(`${LOG_PREFIX} Cleared pending button container check from previous state.`);
        }

        const existingButton = document.getElementById(COPY_BUTTON_ID);

        if (window.location.href.startsWith("https://app.fireflies.ai/view/")) {
            const meetingNoteId = getMeetingNoteIdFromUrl();
            if (meetingNoteId) {
                console.log(`${LOG_PREFIX} Meeting view detected (ID: ${meetingNoteId}). Attempting to add button.`);
                createCopyButton(); // This will set currentWaitForButtonContainerTimer if it starts waiting
            } else {
                console.log(`${LOG_PREFIX} On a /view/ page, but no valid meeting ID found. Button not added/removed.`);
                if (existingButton) {
                    existingButton.remove();
                    console.log(`${LOG_PREFIX} Removed existing button as no valid meeting ID found on /view/ page.`);
                }
            }
        } else {
            console.log(`${LOG_PREFIX} Not a meeting view page. Ensuring button is not present.`);
            if (existingButton) {
                existingButton.remove();
                console.log(`${LOG_PREFIX} Removed existing button as not on a meeting view page.`);
            }
        }
    }

    // Initial run
    initializeActiveViewFeatures();

    // Observe URL changes for SPA navigation
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
        const currentUrl = location.href;
        if (currentUrl !== lastUrl) {
            console.log(`${LOG_PREFIX} URL changed from ${lastUrl} to ${currentUrl}. Re-initializing.`);
            lastUrl = currentUrl;
            initializeActiveViewFeatures();
        }
    });

    // Wait for the body to exist before observing. This waitForElement is for the observer setup, not the button.
    waitForElement('body', (bodyElement) => {
        observer.observe(bodyElement, { childList: true, subtree: true });
        console.log(`${LOG_PREFIX} Mutation observer started on body.`);
    });

})();

