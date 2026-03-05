Run 

az ad sp list --filter "startswith(displayName, 'Azure OSSRDBMS')" --query "[].{appId:appId, displayName:displayName}" -o table

to get list of id's for use with the app registration setting for OBO API permissions. 

ex output

AppId                                 DisplayName
------------------------------------  ------------------------------------------------------------
01c96bfd-e37a-4b52-8481-7bb7f7e550bc  Azure OSSRDBMS Database
cb43afba-eb6b-4cef-bf00-758b6c233beb  Azure OSSRDBMS MySQL Flexible Server BYOK
5657e26c-cc92-45d9-bc47-9da6cfdb4ed9  Azure OSSRDBMS PostgreSQL Flexible Server AAD Authentication

postgres worked with the Azure OSSRDBMS Database one in gov, found this after so the postgres specific one I would think would work

Then Run:

$scopeId = az ad sp show --id <id from above> --query "oauth2PermissionScopes[0].id" -o tsv
az ad app permission add --id <clientid> --api <id from above> --api-permissions "${scopeId}=Scope"

This will register it, but it doesnt seem to show in the UI as there.  but you can see the appid in the Manifest blade.