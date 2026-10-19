--
-- FTPBridge: Enables bidirectional communication between the
-- CustomContracts mod and the FarmBuddy Discord bot via XML files.
--
-- Outbox: Writes full contract state after every sync.
-- Inbox:  Reads command XMLs (create/accept/complete/cancel/delete) from bot.
--

FTPBridge = {}

-- Paths are relative to the savegame profile modSettings folder
FTPBridge.OUTBOX_FOLDER = "FS25_Poslovi/outbox/"
FTPBridge.INBOX_FOLDER  = "FS25_Poslovi/inbox/"
FTPBridge.POLL_INTERVAL = 5000  -- ms between inbox checks
FTPBridge.PROCESSED_IDS = {}    -- transactionId dedup

function FTPBridge:getBasePath()
    local path = getUserProfileAppPath() .. "modSettings/"
    return path
end

function FTPBridge:getOutboxPath()
    return self:getBasePath() .. self.OUTBOX_FOLDER
end

function FTPBridge:getInboxPath()
    return self:getBasePath() .. self.INBOX_FOLDER
end

function FTPBridge:ensureFolders()
    createFolder(self:getBasePath() .. "FS25_Poslovi")
    createFolder(self:getOutboxPath())
    createFolder(self:getInboxPath())
end

---------------------------------------------------------------------------
-- OUTBOX: Write full contract state for the bot to pick up
---------------------------------------------------------------------------
function FTPBridge:writeContractState()
    if not g_currentMission:getIsServer() then return end

    local mgr = g_currentMission.customContracts
    if mgr == nil or mgr.ContractManager == nil then return end

    self:ensureFolders()

    local filePath = self:getOutboxPath() .. "contractsState.xml"
    local key = "ContractsState"
    local xmlFile = createXMLFile(key, filePath, key)
    if xmlFile == nil then return end

    -- Write timestamp
    local env = g_currentMission.environment
    local period = env and env.currentPeriod or 1
    local day = env and (env.currentDayInPeriod or env.currentPeriodDay or 1) or 1
    setXMLInt(xmlFile, key .. "#period", period)
    setXMLInt(xmlFile, key .. "#day", day)
    setXMLInt(xmlFile, key .. "#nextId", mgr.ContractManager.nextId)

    local count = 0
    for _, contract in pairs(mgr.ContractManager.contracts) do
        local cKey = string.format("%s.contract(%d)", key, count)
        setXMLInt(xmlFile, cKey .. "#id", contract.id)
        setXMLInt(xmlFile, cKey .. "#creatorFarmId", contract.creatorFarmId)
        setXMLInt(xmlFile, cKey .. "#contractorFarmId", contract.contractorFarmId or -1)
        setXMLInt(xmlFile, cKey .. "#fieldId", contract.fieldId)
        setXMLString(xmlFile, cKey .. "#workType", contract.workType or "")
        setXMLInt(xmlFile, cKey .. "#reward", contract.reward)
        setXMLString(xmlFile, cKey .. "#status", contract.status)
        setXMLString(xmlFile, cKey .. "#description", contract.description or "")
        setXMLInt(xmlFile, cKey .. "#startPeriod", contract.startPeriod or -1)
        setXMLInt(xmlFile, cKey .. "#startDay", contract.startDay or -1)
        setXMLInt(xmlFile, cKey .. "#duePeriod", contract.duePeriod or -1)
        setXMLInt(xmlFile, cKey .. "#dueDay", contract.dueDay or -1)
        count = count + 1
    end

    saveXMLFile(xmlFile)
    delete(xmlFile)
end

---------------------------------------------------------------------------
-- INBOX: Read command files from the bot
---------------------------------------------------------------------------
function FTPBridge:processInbox()
    if not g_currentMission:getIsServer() then return end

    local mgr = g_currentMission.customContracts
    if mgr == nil or mgr.ContractManager == nil then return end

    self:ensureFolders()

    local inboxPath = self:getInboxPath()
    local files = Files.new(inboxPath)
    if files == nil then return end

    local numFiles = files:getNumOfFiles()
    if numFiles == 0 then
        files:delete()
        return
    end

    for i = 0, numFiles - 1 do
        local fileName = files:getFilenameAt(i)
        if fileName ~= nil and not files:getIsDirectoryAt(i) then
            local ext = fileName:sub(-4):lower()
            if ext == ".xml" then
                local fullPath = inboxPath .. fileName
                self:processInboxFile(fullPath, fileName, mgr.ContractManager)
            end
        end
    end

    files:delete()
end

function FTPBridge:processInboxFile(filePath, fileName, contractManager)
    local key = "FTPCommand"
    local xmlFile = loadXMLFile(key, filePath)
    if xmlFile == nil then
        return
    end

    local transactionId = getXMLString(xmlFile, key .. "#transactionId")
    local cmdType = getXMLString(xmlFile, key .. "#type")

    -- Dedup by transactionId
    if transactionId ~= nil and self.PROCESSED_IDS[transactionId] then
        delete(xmlFile)
        deleteFile(filePath)
        return
    end

    if cmdType == "createContract" then
        self:handleInboxCreate(xmlFile, key, contractManager)
    elseif cmdType == "acceptContract" then
        self:handleInboxAccept(xmlFile, key, contractManager)
    elseif cmdType == "completeContract" then
        self:handleInboxComplete(xmlFile, key, contractManager)
    elseif cmdType == "cancelContract" then
        self:handleInboxCancel(xmlFile, key, contractManager)
    elseif cmdType == "deleteContract" then
        self:handleInboxDelete(xmlFile, key, contractManager)
    end

    -- Mark processed
    if transactionId ~= nil then
        self.PROCESSED_IDS[transactionId] = true
    end

    delete(xmlFile)
    deleteFile(filePath)
end

function FTPBridge:handleInboxCreate(xmlFile, key, contractManager)
    local cKey = key .. ".contract"
    local farmId = getXMLInt(xmlFile, cKey .. "#creatorFarmId")
    if farmId == nil then return end

    local payload = {
        fieldId     = getXMLInt(xmlFile, cKey .. "#fieldId") or 1,
        workType    = getXMLString(xmlFile, cKey .. "#workType") or "Ostalo",
        reward      = getXMLInt(xmlFile, cKey .. "#reward") or 1000,
        description = getXMLString(xmlFile, cKey .. "#description") or "",
        startPeriod = getXMLInt(xmlFile, cKey .. "#startPeriod") or -1,
        startDay    = getXMLInt(xmlFile, cKey .. "#startDay") or -1,
        duePeriod   = getXMLInt(xmlFile, cKey .. "#duePeriod") or -1,
        dueDay      = getXMLInt(xmlFile, cKey .. "#dueDay") or -1,
    }

    contractManager:handleCreateRequest(farmId, payload)
end

function FTPBridge:handleInboxAccept(xmlFile, key, contractManager)
    local cKey = key .. ".contract"
    local farmId = getXMLInt(xmlFile, cKey .. "#farmId")
    local contractId = getXMLInt(xmlFile, cKey .. "#id")
    if farmId == nil or contractId == nil then return end

    contractManager:handleAcceptRequest(farmId, contractId)
end

function FTPBridge:handleInboxComplete(xmlFile, key, contractManager)
    local cKey = key .. ".contract"
    local farmId = getXMLInt(xmlFile, cKey .. "#farmId")
    local contractId = getXMLInt(xmlFile, cKey .. "#id")
    if farmId == nil or contractId == nil then return end

    contractManager:handleCompleteRequest(farmId, contractId)
end

function FTPBridge:handleInboxCancel(xmlFile, key, contractManager)
    local cKey = key .. ".contract"
    local farmId = getXMLInt(xmlFile, cKey .. "#farmId")
    local contractId = getXMLInt(xmlFile, cKey .. "#id")
    if farmId == nil or contractId == nil then return end

    contractManager:handleCancelRequest(farmId, contractId)
end

function FTPBridge:handleInboxDelete(xmlFile, key, contractManager)
    local cKey = key .. ".contract"
    local farmId = getXMLInt(xmlFile, cKey .. "#farmId")
    local contractId = getXMLInt(xmlFile, cKey .. "#id")
    if farmId == nil or contractId == nil then return end

    contractManager:handleDeleteRequest(farmId, contractId)
end
