MenuCreateContract = {}
local MenuCreateContract_mt = Class(MenuCreateContract, MessageDialog)

CustomContractWorkTypes = {
  { id = "CULTIVATE",     text = "Kultiviranje" },
  { id = "PLOW",          text = "Oranje" },
  { id = "SEED",          text = "Sijanje" },
  { id = "FERTILIZE",     text = "Fertilize" },
  { id = "HARVEST",       text = "Branje" },
  { id = "ROLL",          text = "Rolanje" },
  { id = "WEED",          text = "Weed" },
  { id = "LIME",          text = "Lime" },
  { id = "MULCH",         text = "Malčiranje" },
  { id = "STONEPICK",     text = "Skupljanje kamenja" },
  { id = "REMOVEFOLIAGE", text = "Remove Foliage" },
  { id = "REMOVEFOLIAGE", text = "Remove Foliage" },
  { id = "MOW",           text = "Košnja trve" },
  { id = "TEDDING",       text = "Tedding" },
  { id = "WINDROWING",    text = "Windrowing" },
  { id = "BALING",        text = "Baliranje" },
  { id = "BALEWRAPPING",  text = "Zamotavanje bala" },
  { id = "SPRAYING",      text = "Prskanje" },
  { id = "OTHER",         text = "Ostalo" }
}

function MenuCreateContract.new(target, custom_mt)
  local self = MessageDialog.new(target, custom_mt or MenuCreateContract_mt)
  return self
end

function MenuCreateContract:onCreate()
  MenuCreateContract:superClass().onCreate(self)
end

function MenuCreateContract:onGuiSetupFinished()
  MenuCreateContract:superClass().onGuiSetupFinished(self)
end

function MenuCreateContract:onOpen()
  MenuCreateContract:superClass().onOpen(self)

  local workTypeTexts = {}

  for _, workType in ipairs(CustomContractWorkTypes) do
    table.insert(workTypeTexts, workType.text)
  end

  self.workTypeSelector:setTexts(workTypeTexts)
  self.workTypeSelector:setState(1, false)

  local fieldIds = {}

  local farmId = g_currentMission:getFarmId()
  if farmId == nil then
    return
  end

  for _, field in pairs(g_fieldManager:getFields()) do
    if field:getOwner() == farmId then
      table.insert(fieldIds, field:getId())
    end
  end

  table.sort(fieldIds)

  self.fieldIds = fieldIds

  local fieldTexts = {}
  for _, fieldId in ipairs(fieldIds) do
    table.insert(fieldTexts, string.format("Field %d", fieldId))
  end

  self.fieldSelector:setTexts(fieldTexts)
  self.fieldSelector:setState(1, false)

  self:fillMonthMultiTextOption(self.startDateSelector, "startDateValues")
  self:fillMonthMultiTextOption(self.dueDateSelector, "dueDateValues")

  self.selectedStartDateIndex = 1
  self.selectedDueDateIndex   = 1

  self.selectedFieldIndex     = 1
end

function MenuCreateContract:onClose()
  MenuCreateContract:superClass().onClose(self)
end

function MenuCreateContract:onFieldSelectChange(state)
  self.selectedFieldIndex = state
end

function MenuCreateContract:onGroupSelectChange(state)
  self.selectedWorkTypeIndex = state
end

function MenuCreateContract:onStartDateSelectChange(state)
  self.selectedStartDateIndex = state
end

function MenuCreateContract:onDueDateSelectChange(state)
  self.selectedDueDateIndex = state
end

-- XML onClick handlers
function MenuCreateContract:onConfirm(sender)
  if g_client == nil then
    return
  end

  local fieldId = self.fieldIds[self.selectedFieldIndex or 0]
  local reward = tonumber(self.rewardInput:getText())
  local description = self.descriptionInput:getText()

  local index = self.selectedWorkTypeIndex or 1
  local workType = CustomContractWorkTypes[index].text

  if fieldId == nil or reward == nil or workType == nil then
    InfoDialog.show("Molimo ispunite sva polja")
    return
  end

  local startIdx = self.selectedStartDateIndex or 1
  local dueIdx   = self.selectedDueDateIndex or 1

  local startV   = self.startDateValues[self.selectedStartDateIndex or 1]
  local dueV     = self.dueDateValues[self.selectedDueDateIndex or 1]

  if startV == nil or dueV == nil then
    InfoDialog.show("Molimo odaberite datum početka i dospijeća")
    return
  end

  if dueIdx < startIdx then
    InfoDialog.show("Datum dospijeća ne može biti prije datuma početka")
    return
  end

  local contract = {
    fieldId     = fieldId,
    workType    = workType,
    reward      = reward,
    description = description or "-",
    startPeriod = startV.period,
    startDay    = startV.day,
    duePeriod   = dueV.period,
    dueDay      = dueV.day
  }

  g_client:getServerConnection():sendEvent(
    CreateContractEvent.new(contract, g_currentMission:getFarmId())
  )

  self:close()
end

function MenuCreateContract:onCancel(sender)
  self:close()
end

function MenuCreateContract:retrieveFieldInfo(fieldId)
  local field = g_fieldManager:getFieldById(fieldId)

  if field == nil then
    return nil
  end
end

function MenuCreateContract:buildMonthOptionData()
  local env = g_currentMission.environment
  if env == nil then
    return {}, {}
  end

  local currentPeriod = env.currentPeriod

  local daysPerPeriod = env.daysPerPeriod or 1

  local texts = {}
  local values = {}

  for offset = 0, 11 do
    local period = DateUtil.wrapPeriod(currentPeriod + offset)
    local month = DateUtil.periodToMonth(period)

    if daysPerPeriod > 1 then
      for day = 1, daysPerPeriod do
        table.insert(texts,
          string.format("%s %d", DateUtil.getMonthName(month), day)
        )
        table.insert(values, {
          period = period,
          month  = month,
          day    = day
        })
      end
    else
      table.insert(texts, DateUtil.getMonthName(month))
      table.insert(values, {
        period = period,
        month  = month,
        day    = 1
      })
    end
  end

  return texts, values
end

function MenuCreateContract:fillMonthMultiTextOption(multiTextOption, valuesFieldName)
  local texts, values = self:buildMonthOptionData()

  self[valuesFieldName] = values

  multiTextOption:setTexts(texts)
  multiTextOption:setState(1, true)
end
