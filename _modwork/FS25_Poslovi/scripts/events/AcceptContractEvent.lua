AcceptContractEvent = {}
local AcceptContractEvent_mt = Class(AcceptContractEvent, Event)

InitEventClass(AcceptContractEvent, "AcceptContractEvent")

local function getSenderFarmId(connection, fallback)
  -- Try the most common places FS exposes farmId
  if connection ~= nil then
    if connection.getFarmId ~= nil then
      local ok, fid = pcall(function() return connection:getFarmId() end)
      if ok and fid ~= nil then return fid end
    end
    if connection.player ~= nil and connection.player.farmId ~= nil then
      return connection.player.farmId
    end
  end
  return fallback
end


function AcceptContractEvent.emptyNew()
    local self = Event.new(AcceptContractEvent_mt)
    return self
end

function AcceptContractEvent.new(contractId, farmId)
    local self = AcceptContractEvent.emptyNew()
    self.contractId = contractId
    self.farmId = farmId
    return self
end

function AcceptContractEvent:writeStream(streamId, connection)
    streamWriteInt32(streamId, self.contractId)
    streamWriteInt32(streamId, self.farmId)
end

function AcceptContractEvent:readStream(streamId, connection)
    self.contractId = streamReadInt32(streamId)
    self.farmId = streamReadInt32(streamId)
    self:run(connection)
end

function AcceptContractEvent:run(connection)
  local senderFarmId = getSenderFarmId(connection, self.farmId)
    if not connection:getIsServer() then
        g_server:broadcastEvent(AcceptContractEvent.new(self.contractId, senderFarmId))
    end

    local contractManager = g_currentMission.customContracts.ContractManager
    contractManager:handleAcceptRequest(senderFarmId, self.contractId)
end
