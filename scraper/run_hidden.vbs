' Runs a PowerShell script with no window, for the scheduled tasks (registered by scraper\register_daily_refresh.ps1).
' powershell.exe -WindowStyle Hidden still flashes a console for a moment; launched from here, nothing shows.
'   wscript.exe //B run_hidden.vbs <script.ps1> [arguments...]
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & WScript.Arguments(i)
Next
WScript.Quit sh.Run(cmd, 0, True)
