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
-- Note for anyone extending this: WhatsApp's accessibility tree exposes roles
-- but every text value reads as "missing value", and `entire contents of
-- window 1` comes back empty. AXFocusedUIElement is the one thing that works,
-- which is why the check is written this way. The chat TITLE cannot be read at
-- all, so this cannot verify *which* chat is open — only that a composer has
-- focus. That is why the window must stay dedicated to the group.

on run argv
	if (count of argv) < 1 then error "usage: wa-send.applescript <message>"
	set theMessage to item 1 of argv

	tell application "System Events"
		if not (exists process "WhatsApp") then error "WhatsApp is not running"
	end tell

	tell application "WhatsApp" to activate
	delay 1.2

	if not (my composerHasFocus()) then
		error "WhatsApp is not parked on a chat with the message composer focused — refusing to type. Open the group chat and click into the message box."
	end if

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
	return "sent"
end run

-- True only when the focused element is a text area, i.e. the message composer.
on composerHasFocus()
	tell application "System Events"
		tell process "WhatsApp"
			try
				set f to value of attribute "AXFocusedUIElement"
				if (role of f) is "AXTextArea" then return true
			end try
		end tell
	end tell
	return false
end composerHasFocus
