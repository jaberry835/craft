# Azure Deployment Guide

This folder contains scripts and configuration for deploying the Rude Chat application to Azure App Service.

## Architecture

We deploy both the Angular frontend and .NET Core API to the **same App Service** for simplicity:
- The .NET Core API serves the Angular static files
- Angular builds to `wwwroot` which is served by the .NET app
- Single App Service = lower cost and easier management

## Prerequisites

1. Azure CLI installed: `az login`
2. .NET 8+ SDK installed
3. Node.js 18+ installed
4. PowerShell (for Windows deployment scripts)

## Quick Deployment

1. **Configure environment variables** in `config.json`
2. **Run deployment script**: `.\deploy.ps1`
3. **Test the application** at the provided URL

## Environment Variables

The application uses Azure App Service Application Settings for configuration:
- **Backend**: Uses standard .NET configuration (reads from environment variables)
- **Frontend**: Uses build-time environment replacement during deployment

## Files

- `deploy.ps1` - Main deployment script
- `config.json` - Environment configuration template
- `web.config` - IIS configuration for Angular routing
- `appsettings.Production.json` - Production backend configuration
- `environment.prod.ts` - Production frontend configuration template
