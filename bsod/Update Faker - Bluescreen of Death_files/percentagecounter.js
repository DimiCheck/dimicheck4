var count=0;
var percentage=setInterval(percentage, 10000); // /1000 = 10 seconds
var textkind="Configuring updates";
function percentage()
{
  count+=1;

  if (count <= 0){
    clearInterval(percentage);
    return;
  }

  document.getElementById("percentage").innerHTML=count +'%';
   
  if (count > 99){
    count=0;
    return;
  }
}