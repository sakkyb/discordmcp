-- Send a message to the WhatsApp group via the macOS WhatsApp app.
--
--   osascript wa-send.applescript "Today's post is live: https://..."
--
-- Replaces the Playwright/WhatsApp Web path entirely: no Chrome, no profile
-- directory, no QR linking, no daemon. Requires the Mac to be logged in with
-- the WhatsApp app running and parked on the target chat, and it steals focus
-- for about a second per send.
--
-- SAFETY: this never navigates and never searches. It types only when the
-- focused element is already a text area (the message composer), and otherwise
-- fails loudly so the caller can alert.
--
-- An earlier version had a "recovery" path that ran File > Search, typed the
-- group name and pressed Return. The search field does not take focus
-- immediately, so the name went into the composer and Return SENT IT to the
-- group. A recovery path that can post garbage to a real chat is worse than no
-- recovery path; if the app is not parked on the chat, a human should fix it.
--
-- MACOS PERMISSIONS — the thing that will bite you:
-- Sending keystrokes goes through System Events, which needs TWO separate
-- grants, and they attach to the *responsible* process:
--
--   Accessibility  (Privacy & Security > Accessibility)
--   Automation     (caller -> System Events)
--
-- Run from a terminal, the responsible process is the TERMINAL, so its grants
-- cover everything it spawns and this all "just works". Run from launchd, the
-- responsible process is the binary in the plist (/opt/homebrew/bin/node —
-- note that is a DIFFERENT install from a shell's /usr/local/bin/node), which
-- needs its own grants.
--
-- Symptom when Automation has not been granted: osascript HANGS rather than
-- erroring. macOS does raise the "<x> wants access to control System Events"
-- dialog, but a scheduled job has nobody to click it, so it blocks until the
-- caller's timeout. If a send times out with no stderr, look at the screen for
-- a pending permission dialog before assuming the script is broken.
--
-- Verify the real path with: npm run wa:test  (run it under launchd, not just
-- from a shell — a shell test passes even when production is broken).

-- Note for anyone extending this: WhatsApp's accessibility tree exposes roles
-- but every text value reads as "missing value", and `entire contents of
-- window 1` comes back empty. AXFocusedUIElement is the one thing that works,
-- which is why the check is written this way. The chat TITLE cannot be read at
-- all, so this cannot verify *which* chat is open — only that a composer has
-- focus. That is why the window must stay dedicated to the group.

on run argv
	if (count of argv) < 1 then error "usage: wa-send.applescript prepare | send <message>"
	set mode to item 1 of argv

	tell application "System Events"
		if not (exists process "WhatsApp") then error "WhatsApp is not running"
	end tell

	tell application "WhatsApp" to activate
	delay 1.2

	-- Having the chat open is NOT the same as the composer having keyboard focus.
	-- If anything else was clicked last (the message list, the search box), or the
	-- app was activated from the background, focus lands on an AXGroup instead —
	-- which is exactly how this failed in production on 2026-08-14. So try to
	-- focus the composer first, and only then insist on it.
	if not (my composerHasFocus()) then
		my clickComposer()
		if not (my composerHasFocus()) then
			error "WhatsApp is not parked on a chat with the message composer focused — refusing to type. Open the group chat and click into the message box."
		end if
	end if

	if mode is "prepare" then
		-- Hand the window geometry back so the caller can screenshot the chat
		-- header and confirm WHICH chat this is before anything gets typed.
		-- The accessibility tree exposes no text, so OCR is the only way to know.
		tell application "System Events" to tell process "WhatsApp"
			set p to position of window 1
			set sz to size of window 1
			set b to ((item 1 of p) as integer) as text
			set b to b & "," & (((item 2 of p) as integer) as text)
			set b to b & "," & (((item 1 of sz) as integer) as text)
			set b to b & "," & (((item 2 of sz) as integer) as text)
			return b
		end tell
	end if

	if mode is not "send" then error "unknown mode: " & mode
	if (count of argv) < 2 then error "send mode needs a message"
	my typeAndSend(item 2 of argv)
	return "sent"
end run

-- True only when WhatsApp is FRONTMOST *and* its focused element is a text area.
--
-- Both halves matter. AXFocusedUIElement reports the app's INTERNAL focus, which
-- stays on the composer even while the app sits in the background — but
-- `keystroke` goes to whatever is frontmost, not to whoever owns that attribute.
-- Checking focus alone let a launchd run report "sent" while typing into another
-- application entirely: the message never reached the chat and nothing errored.
on composerHasFocus()
	tell application "System Events"
		try
			if not (frontmost of process "WhatsApp") then return false
		on error
			return false
		end try
		tell process "WhatsApp"
			try
				set f to value of attribute "AXFocusedUIElement"
				if (role of f) is "AXTextArea" then return true
			end try
		end tell
	end tell
	return false
end composerHasFocus

-- Click where the composer sits: bottom-centre of the window. WhatsApp's
-- accessibility tree is too shallow to locate the element (window 1 exposes one
-- group containing one group, and no text areas at any level), so position is
-- the only handle available.
--
-- Clicking is safe even if the aim is wrong: it cannot send anything, and
-- composerHasFocus() still gates the typing. With no chat open there is no
-- composer, focus does not become AXTextArea, and the caller refuses as before.
on clickComposer()
	tell application "System Events"
		tell process "WhatsApp"
			try
				set p to position of window 1
				set sz to size of window 1
				set cx to (item 1 of p) + (item 1 of sz) / 2
				set cy to (item 2 of p) + (item 2 of sz) - 30
				click at {cx, cy}
				delay 0.8
			end try
		end tell
	end tell
end clickComposer

on typeAndSend(theMessage)
	tell application "System Events"
		tell process "WhatsApp"
			-- Clear any half-typed draft so it is not prepended to the message.
			keystroke "a" using command down
			delay 0.2
			key code 51
			delay 0.3

			keystroke theMessage
			delay 0.6
			key code 36 -- Return sends
			delay 0.5
		end tell
	end tell
end typeAndSend
