$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$localPython = Join-Path $projectDir 'venv/Scripts/python.exe'
$buildPython = if ($env:REFACE_BUILD_PYTHON) { $env:REFACE_BUILD_PYTHON }
    elseif (Test-Path -LiteralPath $localPython) { $localPython }
    else { 'python' }

Push-Location $projectDir
try {
    & $buildPython -m PyInstaller --version
    if ($LASTEXITCODE -ne 0) { throw 'Install the build dependency with: python -m pip install -r scripts/build-requirements.txt' }
    & $buildPython scripts/build-app-icon.py
    if ($LASTEXITCODE -ne 0) { throw 'Application icon generation failed.' }

    $builderArgs = @(
        '-m', 'PyInstaller', '--noconfirm', '--onedir', '--console',
        '--name', 'reface-backend', '--distpath', 'dist/backend',
        '--workpath', 'dist/backend-work', '--specpath', 'dist/backend-work',
        # '--add-data', 'backend/blender_scripts;blender_scripts',
        '--add-data', ((Join-Path $projectDir 'backend/blender_scripts') + ';blender_scripts'),
        '--collect-submodules', 'google.generativeai',
        '--collect-submodules', 'google.ai.generativelanguage',
        '--collect-data', 'speech_recognition',
        '--hidden-import', 'speech_recognition.recognizers.google'
    )
    # These optional speech engines are unused; browser audio uses Google's recognizer.
    foreach ($module in @('torch', 'torchaudio', 'torchvision', 'tensorflow', 'whisper',
        'faster_whisper', 'transformers', 'pyaudio', 'PyQt5', 'PyQt6', 'PySide6', 'tkinter')) {
        $builderArgs += @('--exclude-module', $module)
    }
    $builderArgs += 'backend/server.py'
    & $buildPython @builderArgs
    if ($LASTEXITCODE -ne 0) { throw 'Backend executable build failed.' }
} finally {
    Pop-Location
}
