module example.com/consumer

go 1.22

require example.com/sdk v1.0.0

replace example.com/sdk => ../sdk/v1

replace example.com/sdk/v2 => ../sdk/v2
