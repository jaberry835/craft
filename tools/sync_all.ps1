#!/usr/bin/env pwsh
# sync_all.ps1 — Run add_repo.py against all tracked projects

$repos = @(
   # @{ Url = "https://github.com/adamruderman/UserAccessCheckerApi"; Branch = "main" }
    @{ Url = "https://github.com/adamruderman/AgentChatV2"; Branch = "main" }
    @{ Url = "https://github.com/adamruderman/Rude-MCPServer"; Branch = "main" }
    #@{ Url = "https://github.com/adamruderman/UserAccessChecker-Python"; Branch = "main" }
   # @{ Url = "https://github.com/jaberry835/snapseek"; Branch = "main" }
    #@{ Url = "https://github.com/microsoft/simplechat"; Branch = "main" }
    #@{ Url = "https://github.com/jaberry835/snapseek"; Branch = "deepface-embeddings" }
    #@{ Url = "https://github.com/adamruderman/WebScrapeAndIndex"; Branch = "main" }
   # @{ Url = "https://github.com/adamruderman/SecureAPI"; Branch = "main" } 
    #@{ Url = "https://github.com/adamruderman/McpServer"; Branch = "main" }
    @{ Url = "https://github.com/adamruderman/SecureChatExtension"; Branch = "main" },
    @{Url= "https://github.com/adamruderman/SecureChatExtension"; Branch ="msal-config"
   
     
)

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Get-Location }

$addRepo = Join-Path $scriptDir "add_repo.py"

foreach ($repo in $repos) {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "Syncing: $($repo.Url) ($($repo.Branch))" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    python $addRepo $repo.Url $repo.Branch
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR syncing $($repo.Url)" -ForegroundColor Red
    }
}

Write-Host "`nAll repos processed." -ForegroundColor Green
