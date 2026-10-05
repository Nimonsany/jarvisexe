tell application "System Events"
	repeat with pname in {"SecurityAgent", "UserNotificationCenter"}
		try
			tell (first process whose name is pname)
				repeat with w in (windows)
					set t to ""
					try
						set t to name of w
					end try
					set has_dont to false
					set has_ok to false
					set btns to {}
					try
						set btns to buttons of w
						repeat with b in btns
							set bn to ""
							try
								set bn to name of b
							end try
							if bn is "Don't Allow" then set has_dont to true
							if bn is "OK" then set has_ok to true
						end repeat
					end try
					set take to false
					if pname is "SecurityAgent" and (t contains "JARVIS" or t contains "jarvis-desktop" or t contains "jarvis-core" or t contains "Google Chrome" or t contains "Chromium") then set take to true
					if pname is "UserNotificationCenter" and has_dont and has_ok then set take to true
					if take then
						repeat with b in btns
							set bn to ""
							try
								set bn to name of b
							end try
							if bn is in {"Allow", "Allow Once", "OK", "Continue", "Open"} then
								log "clicked " & bn
								click b
							end if
						end repeat
					end if
				end repeat
			end tell
		end try
	end repeat
end tell
return ""
