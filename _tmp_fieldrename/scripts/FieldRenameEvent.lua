--
-- FieldRenameEvent
-- Network event for syncing field name changes in multiplayer
--

FieldRenameEvent = {}

local FieldRenameEvent_mt = Class(FieldRenameEvent, Event)
InitEventClass(FieldRenameEvent, "FieldRenameEvent")

function FieldRenameEvent.emptyNew()
    local self = Event.new(FieldRenameEvent_mt)
    return self
end

--- Create event for a single field rename
---@param fieldId number The farmland ID
---@param fieldName string|nil The custom name (nil to clear)
function FieldRenameEvent.new(fieldId, fieldName)
    local self = FieldRenameEvent.emptyNew()
    self.fieldId = fieldId
    self.fieldName = fieldName
    self.syncAll = false
    return self
end

--- Create event to sync all field names (for new client joining)
function FieldRenameEvent.newSyncAll()
    local self = FieldRenameEvent.emptyNew()
    self.syncAll = true
    return self
end

function FieldRenameEvent:readStream(streamId, connection)
    self.syncAll = streamReadBool(streamId)

    if self.syncAll then
        -- Reading all field names
        local count = streamReadUInt16(streamId)
        self.fieldNames = {}
        for i = 1, count do
            local fieldId = streamReadUInt16(streamId)
            local fieldName = streamReadString(streamId)
            self.fieldNames[fieldId] = fieldName
        end
    else
        -- Reading single field rename
        self.fieldId = streamReadUInt16(streamId)
        if streamReadBool(streamId) then
            self.fieldName = streamReadString(streamId)
        else
            self.fieldName = nil
        end
    end

    self:run(connection)
end

function FieldRenameEvent:writeStream(streamId, connection)
    streamWriteBool(streamId, self.syncAll)

    if self.syncAll then
        -- Writing all field names
        local count = 0
        for _ in pairs(FieldRename.fieldNames) do
            count = count + 1
        end
        streamWriteUInt16(streamId, count)
        for fieldId, fieldName in pairs(FieldRename.fieldNames) do
            streamWriteUInt16(streamId, fieldId)
            streamWriteString(streamId, fieldName)
        end
    else
        -- Writing single field rename
        streamWriteUInt16(streamId, self.fieldId)
        if self.fieldName ~= nil then
            streamWriteBool(streamId, true)
            streamWriteString(streamId, self.fieldName)
        else
            streamWriteBool(streamId, false)
        end
    end
end

function FieldRenameEvent:run(connection)
    if self.syncAll then
        -- Apply all field names (client receiving sync from server)
        FieldRename.fieldNames = self.fieldNames or {}
        FieldRename.updateAllHotspots()
    else
        -- Apply single field rename (use noSync=true to avoid re-sending)
        FieldRename.setFieldName(self.fieldId, self.fieldName, true)

        -- If we're the server, broadcast to all other clients
        if g_server ~= nil then
            g_server:broadcastEvent(FieldRenameEvent.new(self.fieldId, self.fieldName), nil, connection)
        end
    end
end

--- Send a field rename to server (and broadcast to clients if we are server)
---@param fieldId number The farmland ID
---@param fieldName string|nil The custom name
function FieldRenameEvent.sendEvent(fieldId, fieldName)
    if g_server ~= nil then
        -- We are the server, broadcast to all clients
        g_server:broadcastEvent(FieldRenameEvent.new(fieldId, fieldName))
    else
        -- We are a client, send to server
        g_client:getServerConnection():sendEvent(FieldRenameEvent.new(fieldId, fieldName))
    end
end

--- Sync all field names to a specific connection (called when client joins)
---@param connection table The connection to sync to
function FieldRenameEvent.sendSyncAll(connection)
    connection:sendEvent(FieldRenameEvent.newSyncAll())
end
