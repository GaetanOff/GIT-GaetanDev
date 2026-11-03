; "Open in GaetanDev Git" on folders and folder backgrounds in Explorer.
; The app opens the folder it is given (see folderArg in src/main/index.ts).

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\GaetanDevGit" "" "Open in GaetanDev Git"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GaetanDevGit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\GaetanDevGit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GaetanDevGit" "" "Open in GaetanDev Git"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GaetanDevGit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\GaetanDevGit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\GaetanDevGit"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\GaetanDevGit"
!macroend
