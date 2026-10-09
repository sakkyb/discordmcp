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
	if (count of argv) < 1 then error "usage: wa-send.applescript probe | prepare | send <message>"
	set mode to item 1 of argv

	-- `probe` reports state and returns. It must run BEFORE the WhatsApp-running
	-- check and before activate, because "WhatsApp isn't running" is itself a
	-- diagnosis we want reported rather than thrown — and because a probe that
	-- activates the app would change the very state it is trying to observe.
	if mode is "probe" then return my probeState()

	-- `recover <action>` re-asserts one precondition and returns "ok", so the
	-- caller can retry a failed send in the same run instead of waiting 30
	-- minutes for the next launchd slot. Like `probe` it runs BEFORE the
	-- is-running check, because launching the app is one of the remedies.
	--
	-- None of these actions can send anything: they activate, press Escape and
	-- click the composer. typeAndSend is still gated by composerHasFocus().
	if mode is "recover" then
		if (count of argv) < 2 then error "recover mode needs an action"
		set extra to ""
		if (count of argv) >= 3 then set extra to item 3 of argv
		return my recover(item 2 of argv, extra)
	end if

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

-- One remedy per recoverable cause (see lib/wa-recover.ts). Each waits for the
-- condition it is asserting rather than sleeping a fixed amount, and errors if
-- the condition never arrives, so a remedy that did not work is never reported
-- as one that did.
on recover(action, extra)
	-- The window was closed (Cmd-W / red button) while the app kept running.
	-- `activate` never reopens a closed window — verified 2026-10-09 — but
	-- `reopen` does, in about a second. It comes back on the chat list with NO
	-- chat open, so the group has to be found again: WhatsApp's own search,
	-- typed only while no composer exists to type into, then Return opens the
	-- top match. The OCR header check still runs before anything is sent.
	if action is "reopen-chat" then
		if extra is "" then error "reopen-chat needs the group name"
		tell application "WhatsApp" to activate
		set haveWindow to false
		tell application "System Events" to tell process "WhatsApp"
			if (count of windows) > 0 then set haveWindow to true
		end tell
		if not haveWindow then
			-- The app's own menu item is the canonical way back; `reopen` is the
			-- fallback. Both bring the window up in about a second.
			try
				tell application "System Events" to tell process "WhatsApp"
					click (first menu item of menu 1 of (first menu bar item of menu bar 1 whose name ends with "WhatsApp") whose name ends with "Open main window")
				end tell
			on error
				tell application "WhatsApp" to reopen
			end try
			repeat 30 times
				delay 0.5
				tell application "System Events" to tell process "WhatsApp"
					if (count of windows) > 0 then set haveWindow to true
				end tell
				if haveWindow then exit repeat
			end repeat
			if not haveWindow then error "WhatsApp did not reopen a window within 15s"
			delay 1
		end if
		if my composerHasFocus() then return "ok"

		-- The window is back but no chat is open (or focus is elsewhere). Find
		-- the group again through the chat-list search box. The box sits at a
		-- fixed offset in the top-left of the window at every width the app
		-- allows, and it must be a REAL click: see wa-click.jxa.
		tell application "System Events" to tell process "WhatsApp"
			set p to position of window 1
		end tell
		my realClick((item 1 of p) + 250, (item 2 of p) + 67, 1)
		delay 0.6
		-- Never type into a composer. The search box reads as a generic element
		-- (never AXTextArea), so a focused composer here means the click missed.
		if my composerHasFocus() then return "ok"
		tell application "System Events" to tell process "WhatsApp"
			keystroke "a" using command down
			delay 0.2
			keystroke extra
			delay 1.5
			key code 36
			delay 1.5
		end tell
		if my composerHasFocus() then return "ok"
		-- Return did not open the top match (it does not when the chat is
		-- "selected" but its conversation view was dismissed). Double-click the
		-- first result row: its centre sat at +155 and +205 in the two layouts
		-- seen, and rows are ~60px tall, so +180 lands on it in both.
		my realClick((item 1 of p) + 250, (item 2 of p) + 180, 2)
		delay 1.2
		if my composerHasFocus() then return "ok"
		my clickComposer()
		if my composerHasFocus() then return "ok"
		error "reopened the window but could not open the chat and focus the composer"
	end if

	if action is "launch-app" then
		tell application "WhatsApp" to activate
		repeat 30 times
			delay 0.5
			tell application "System Events"
				if (exists process "WhatsApp") then
					tell process "WhatsApp"
						if (count of windows) > 0 then return "ok"
					end tell
				end if
			end tell
		end repeat
		error "WhatsApp did not open a window within 15s of being launched"
	end if

	tell application "System Events"
		if not (exists process "WhatsApp") then error "WhatsApp is not running"
	end tell

	if action is "activate" then
		tell application "WhatsApp" to activate
		repeat 20 times
			delay 0.5
			tell application "System Events"
				if (name of first process whose frontmost is true) is "WhatsApp" then return "ok"
			end tell
		end repeat
		error "WhatsApp did not come frontmost within 10s"
	end if

	error "unknown recover action: " & action
end recover

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

-- Report the state a failed send actually saw. Every field is independently
-- try-wrapped: a probe that throws tells us nothing, and it runs precisely when
-- things are already broken.
--
-- Deliberately does NOT activate WhatsApp or check that it is running — both
-- would alter or abort the observation. "WhatsApp isn't running" shows up here
-- as windowCount=0 with some other app frontmost, which is the useful form.
on probeState()
	set waFront to "false"
	set frontApp to "unknown"
	set focRole to "none"
	set winCount to "0"
	set b to ""
	set procRunning to "false"
	tell application "System Events"
		try
			if (exists process "WhatsApp") then set procRunning to "true"
		end try
		try
			set frontApp to name of first process whose frontmost is true
		end try
		try
			if frontmost of process "WhatsApp" then set waFront to "true"
		end try
		try
			tell process "WhatsApp"
				try
					set winCount to (count of windows) as text
				end try
				try
					set f to value of attribute "AXFocusedUIElement"
					set focRole to (role of f) as text
				end try
				try
					set p to position of window 1
					set sz to size of window 1
					set b to (((item 1 of p) as integer) as text) & "," & (((item 2 of p) as integer) as text) & "," & (((item 1 of sz) as integer) as text) & "," & (((item 2 of sz) as integer) as text)
				end try
			end tell
		end try
	end tell
	return "waFrontmost=" & waFront & "|frontmostApp=" & frontApp & "|focusedRole=" & focRole & "|windowCount=" & winCount & "|bounds=" & b & "|running=" & procRunning
end probeState

-- A genuine mouse click (see wa-click.jxa for why System Events' own click
-- is not enough here). Coordinates are screen pixels.
on realClick(x, y, n)
	set here to do shell script "dirname " & quoted form of POSIX path of (path to me)
	do shell script "/usr/bin/osascript -l JavaScript " & quoted form of (here & "/wa-click.jxa") & " " & ((x as integer) as text) & " " & ((y as integer) as text) & " " & (n as text)
end realClick

-- Click where the composer sits: bottom of the chat pane. WhatsApp's
-- accessibility tree is too shallow to locate the element (window 1 exposes one
-- group containing one group, and no text areas at any level), so position is
-- the only handle available. Three-quarters across, not the centre: at the
-- main window's 800px minimum width the chat list fills the left ~45%, and a
-- centre click landed in the list and opened whichever chat sat there
-- (2026-10-09). 75% is inside the composer at every width the app allows.
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
				set cx to (item 1 of p) + (item 1 of sz) * 0.75
				set cy to (item 2 of p) + (item 2 of sz) - 30
				my realClick(cx, cy, 1)
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
